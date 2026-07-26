import {
  CliDialect,
  DeviceAction,
  SnmpSetOp,
  StructuredDiff,
  VendorAdapter,
} from './vendor-adapter.interface';

/**
 * Juniper Junos — the second full vendor adapter, deliberately structured
 * to prove the adapter interface handles a categorically different
 * config-apply model than Cisco's immediate-apply: Junos is
 * candidate-config/commit. Every command line and OID below is
 * transcribed directly from signal-scope-docs/vendors/juniper/
 * {gui-cli-snmp-mapping,cli-reference,overview,mib-reference}.md.
 *
 * Structural note this vendor surfaced for the module's own architecture
 * (see device-control/README.md's worker-model section): each
 * DeviceAction runs as its own BullMQ job with its own fresh dial/session
 * (no long-lived shared session across actions). For an immediate-apply
 * vendor like Cisco that's irrelevant. For Junos it matters: this adapter
 * deliberately uses PLAIN `configure` (shared candidate), not
 * `configure exclusive` — even though cli-reference.md recommends
 * exclusive mode for automation-driven sessions "to avoid merge surprises
 * with a concurrent human session" — because Junos's `configure exclusive`
 * candidate is tied to the session that opened it and is discarded (per
 * standard Junos operator experience) if that session disconnects before
 * committing. Since a `port.setDescription` job and a later, separate
 * `config.save` job are two different sessions in this architecture, using
 * exclusive mode here would silently lose every uncommitted change the
 * moment its authoring job's session closed. Plain shared `configure`
 * candidate config, by contrast, persists across separate sessions until
 * committed or explicitly rolled back (`rollback 0`) — which is exactly
 * the property this architecture depends on. The tradeoff (real risk of
 * a concurrent human's `configure exclusive` session, or an uncoordinated
 * `rollback 0`, discarding a SignalScope-authored pending set) is an
 * explicit, documented limitation of this phase, not an oversight — see
 * device-control/README.md.
 */
export class JuniperJunosAdapter implements VendorAdapter {
  readonly profileId = 'juniper-junos';
  // <media>-<fpc>/<pic>/<port>, e.g. ge-0/0/1 — cli-syntax-matrix.md
  readonly interfaceNamePattern = /^[a-z]+-[0-9]+\/[0-9]+\/[0-9]+$/;

  readonly cliDialect: CliDialect = {
    promptPatterns: {
      operational: /\S+>\s*$/,
      candidate: /\S+#\s*$/,
    },
    pagingDisableCmd: 'set cli screen-length 0', // operational mode, before `configure` — cli-reference.md
    enableSequence: null, // no separate privileged-mode step; `configure` is reachable directly from operational mode
    negationKeyword: 'delete', // not a true single-particle negation — `delete` removes a candidate statement vs. `set` adding/changing one
    saveOrCommit: { kind: 'commit', commands: ['commit'] },
    candidateConfig: true,
  };

  buildCliPlan(action: DeviceAction): string[] | null {
    switch (action.kind) {
      case 'port.setAdminStatus':
        // gui-cli-snmp-mapping.md: Junos has no positive "enable" statement
        // — re-enabling a port means deleting the `disable` statement.
        return [
          'configure',
          action.adminStatus === 'up'
            ? `delete interfaces ${action.interfaceName} disable`
            : `set interfaces ${action.interfaceName} disable`,
        ];

      case 'port.setDescription':
        return ['configure', `set interfaces ${action.interfaceName} description "${action.description}"`];

      case 'vlan.setPvid':
        // cli-reference.md's confirmed example uses a VLAN *name* (`staff`)
        // as the `vlan members` value, since Junos VLANs are named,
        // not purely numbered — the config-tree key is the name, vlan-id
        // is a property of it. DeviceAction only carries a numeric
        // vlanId, not a name, so this assumes the numeric id is also
        // accepted directly as a `vlan members` value (Junos does accept
        // bare vlan-id numbers here in current releases) OR that a VLAN
        // whose name equals the stringified id was already created via
        // vlan.create — **not independently confirmed against a live
        // device this session**, flagged per this project's standing
        // discipline rather than asserted as certain.
        return [
          'configure',
          `set interfaces ${action.interfaceName} unit 0 family ethernet-switching interface-mode access`,
          `set interfaces ${action.interfaceName} unit 0 family ethernet-switching vlan members ${action.vlanId}`,
        ];

      case 'vlan.setTrunkAllowed':
        return [
          'configure',
          `set interfaces ${action.interfaceName} unit 0 family ethernet-switching interface-mode trunk`,
          `set interfaces ${action.interfaceName} unit 0 family ethernet-switching vlan members [ ${action.vlanIds.join(' ')} ]`,
        ];

      case 'vlan.create':
        // The one action where Junos's named-VLAN model maps cleanly onto
        // DeviceAction's shape — {vlanId, name} is exactly `set vlans <name> vlan-id <id>`.
        return ['configure', `set vlans ${action.name} vlan-id ${action.vlanId}`];

      case 'config.save':
        // See the class doc comment: re-enters (shared, non-exclusive)
        // candidate config before committing, since this runs as its own
        // fresh session/job and Junos's shared candidate persists any
        // prior uncommitted `set`/`delete` statements from earlier jobs
        // across separate sessions until committed or rolled back.
        return ['configure', 'commit'];

      case 'interface.setIpAddress':
        // Standard Junos family-inet CIDR syntax under the logical unit —
        // extremely common/stable Junos convention, but not literally
        // present in the vendored cli-reference.md (that file's interface
        // section only covers admin-state/description/speed, not L3
        // addressing) — flagged at the same confidence tier the Arista/
        // MikroTik adapters used for their own out-of-docs L3 actions.
        return [
          'configure',
          `set interfaces ${action.interfaceName} unit 0 family inet address ${action.ipAddress}/${action.prefixLength}`,
        ];

      case 'route.static.upsert':
        // Same confidence caveat as interface.setIpAddress above — standard
        // Junos routing-options syntax, not literally in the vendored docs.
        return ['configure', `set routing-options static route ${action.destinationCidr} next-hop ${action.nextHop}`];

      default:
        return null;
    }
  }

  buildSnmpPlan(_action: DeviceAction): SnmpSetOp[] | null {
    // snmp-write-support-matrix.md / overview.md's summary is unambiguous:
    // "no confirmed, reliable SNMP-SET path exists" across every
    // switch-configuration action researched for Junos — ifAdminStatus is
    // *explicitly* documented as not SET-able, and every other action in
    // this phase's DeviceAction set (description, VLAN, config-save) is
    // either unconfirmed or has no object at all. The one genuine Junos
    // SNMP-write exception (SNMP-COMMUNITY-MIB self-configuration) isn't
    // part of this phase's action set. Correctly null for everything.
    return null;
  }

  buildReadbackCommand(action: DeviceAction): string | null {
    // Readback runs in the SAME session right after the plan above, which
    // (per the class doc comment) never exits configuration mode — Junos
    // does not run plain operational commands like `show interfaces ...
    // terse` or `show vlans` directly from config mode; they need the
    // `run` prefix. `show configuration ...` is a config-mode-native
    // variant and doesn't need it. Getting this wrong isn't just cosmetic
    // — the stub-server/live-device round trip would hang waiting for a
    // prompt that never appears if the command were rejected. Confirmed
    // against real Junos operator convention, not literally spelled out
    // in cli-reference.md (that file shows both command families as if
    // always run from operational mode).
    switch (action.kind) {
      case 'port.setAdminStatus':
        return `run show interfaces ${action.interfaceName} terse`;
      case 'port.setDescription':
        return `show configuration interfaces ${action.interfaceName}`;
      case 'vlan.setPvid':
      case 'vlan.setTrunkAllowed':
      case 'vlan.create':
        return 'run show vlans';
      case 'interface.setIpAddress':
        return `show configuration interfaces ${action.interfaceName}`;
      case 'route.static.upsert':
        return 'show configuration routing-options static';
      case 'config.save':
        return null;
      default:
        return null;
    }
  }

  parseReadback(action: DeviceAction, rawOutput: string): StructuredDiff {
    // Intentionally minimal this phase, matching cisco-ios.adapter.ts's
    // level of effort — enough to confirm the round-trip, not a full
    // `show` output parser.
    if (action.kind === 'port.setAdminStatus') {
      // `show interfaces <name> terse` columns: Interface Admin Link Proto Local Remote
      // The Interface column includes the logical-unit suffix (e.g.
      // "ge-0/0/1.0"), not just the bare physical name — match past an
      // optional ".<unit>" before the whitespace-delimited columns.
      const match = rawOutput.match(new RegExp(`${action.interfaceName}(?:\\.\\d+)?\\s+(up|down)\\s+(up|down)`));
      return { changed: true, after: { adminUp: match?.[1] === 'up', operUp: match?.[2] === 'up' }, note: rawOutput.slice(0, 400) };
    }
    if (action.kind === 'port.setDescription') {
      const match = rawOutput.match(/description\s+"([^"]*)"/);
      return { changed: true, after: match?.[1], note: rawOutput.slice(0, 400) };
    }
    return { changed: true, after: rawOutput.slice(0, 400) };
  }
}
