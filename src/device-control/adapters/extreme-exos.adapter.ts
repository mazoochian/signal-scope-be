import {
  CliDialect,
  DeviceAction,
  SnmpSetOp,
  StructuredDiff,
  VendorAdapter,
} from './vendor-adapter.interface';

/**
 * Extreme Networks ExtremeXOS (EXOS). Every command line and OID below is
 * transcribed directly from signal-scope-docs/vendors/extreme/
 * {overview,cli-reference,mib-reference}.md.
 *
 * Structural note: unlike every other vendor implemented so far, EXOS has
 * no persistent interface/config sub-mode — every command is a single,
 * self-contained line with the port list or VLAN name as an explicit
 * argument (`enable port 1:3`, not `interface 1:3` then `no shutdown`).
 * There is also no separate user/privileged EXEC split. This adapter
 * therefore only declares one CliMode ('exec') — there is no mode to
 * enter/exit, so buildCliPlan never emits mode-entry/exit lines the way
 * Cisco's `configure terminal` / `interface X` / `end` does.
 *
 * SNMP write scope is deliberately narrow: overview.md's "Practical scope
 * of SNMP write on EXOS" table explicitly instructs "SignalScope should
 * treat all EXOS actions as CLI-only except the specific objects [listed]
 * until each is separately confirmed" — this adapter's buildSnmpPlan
 * follows that instruction literally rather than extending write coverage
 * to objects that are merely MAX-ACCESS read-write in MIB source (the
 * project's standing "MAX-ACCESS read-write != a supported SET workflow"
 * caveat, e.g. Cisco's port-security case). vlan.setTrunkAllowed is a
 * deliberate case of this: Q-BRIDGE-MIB::dot1qVlanStaticEgressPorts is
 * documented as Read-Create, but it's a per-VLAN port bitmask requiring a
 * read-modify-write to add one port without silently clobbering existing
 * members — not a safe single-SET operation the way a scalar object like
 * dot1qPvid is — so this returns null (CLI-only) despite the object
 * nominally being writable. mib-reference.md also flags an EXOS-specific
 * RFC deviation worth carrying forward: EXOS has no separate egress vs.
 * ingress state, so writing a VLAN's egress-ports set makes those ports
 * both egress AND ingress members.
 *
 * interface.setIpAddress and route.static.upsert are out of scope for the
 * consulted docs (cli-reference.md covers L2 switching only) — EXOS's L3
 * model is VLAN-SVI-based (`configure vlan <name> ipaddress ...`), not
 * physical-port-based, and this phase's DeviceAction doesn't carry VLAN
 * context for a physical interfaceName. Returning null rather than
 * inventing untested syntax, per this project's standing discipline.
 */
export class ExtremeExosAdapter implements VendorAdapter {
  readonly profileId = 'extreme-exos';
  // EXOS native <slot>:<port> form (e.g. 1:3), or a bare port number on
  // fixed single-slot switches — cli-reference.md's own header note.
  readonly interfaceNamePattern = /^\d+(:\d+)?$/;

  readonly cliDialect: CliDialect = {
    // EXOS prompt convention (e.g. "Switch.5 # ") is general vendor
    // knowledge, not literally spelled out in cli-reference.md (which
    // omits example session output) — flagged at the same confidence tier
    // other adapters use for out-of-docs but well-established syntax.
    promptPatterns: {
      exec: /\S+\.\d+\s*#\s*$/,
    },
    // "Session-scoped only" per cli-reference.md — must be re-sent every session.
    pagingDisableCmd: 'disable clipaging',
    enableSequence: null, // no separate privileged-mode step
    negationKeyword: null, // enable/disable are paired verbs, not a single negation particle
    saveOrCommit: { kind: 'persist', commands: ['save configuration'] },
    candidateConfig: false,
  };

  buildCliPlan(action: DeviceAction): string[] | null {
    switch (action.kind) {
      case 'port.setAdminStatus':
        return [action.adminStatus === 'up' ? `enable port ${action.interfaceName}` : `disable port ${action.interfaceName}`];

      case 'port.setDescription':
        // cli-reference.md: description-string maps to ifAlias, up to 255
        // chars, quote if it contains spaces/punctuation — always quoted here.
        return [`configure ports ${action.interfaceName} description-string "${action.description}"`];

      case 'vlan.setPvid':
        // EXOS ties PVID/access-VLAN assignment to untagged VLAN membership
        // — there is no separate "set PVID" command in cli-reference.md,
        // only VLAN untagged-port membership, and an untagged port can only
        // belong to one untagged VLAN at a time. DeviceAction only carries
        // a numeric vlanId, not a name, and `configure vlan <name>`
        // addresses VLANs by name — this assumes a VLAN whose name equals
        // the stringified vlan ID exists (e.g. created via vlan.create
        // using that convention). Not independently confirmed against a
        // live device this session, same caveat class as Juniper's
        // vlan.setPvid.
        return [`configure vlan ${action.vlanId} add ports ${action.interfaceName} untagged`];

      case 'vlan.setTrunkAllowed':
        // One line per VLAN — EXOS has no single "set the whole
        // trunk-allowed list" command; each `add ports ... tagged` line
        // adds this port as a tagged member of one VLAN. Same
        // VLAN-name-vs-id caveat as vlan.setPvid above.
        return action.vlanIds.map((id) => `configure vlan ${id} add ports ${action.interfaceName} tagged`);

      case 'vlan.create':
        // cli-reference.md's confirmed one-line form combining create + tag.
        return [`create vlan ${action.name} tag ${action.vlanId}`];

      case 'config.save':
        return [this.cliDialect.saveOrCommit.commands[0]];

      case 'interface.setIpAddress':
      case 'route.static.upsert':
        return null;

      default:
        return null;
    }
  }

  buildSnmpPlan(action: DeviceAction): SnmpSetOp[] | null {
    switch (action.kind) {
      case 'port.setAdminStatus':
        // overview.md's write-scope table explicitly lists IF-MIB::ifAdminStatus.
        return [
          {
            oid: '1.3.6.1.2.1.2.2.1.7.<ifIndex>',
            type: 'Integer',
            value: action.adminStatus === 'up' ? 1 : 2,
            description: `IF-MIB::ifAdminStatus.<ifIndex> = ${action.adminStatus === 'up' ? 'up(1)' : 'down(2)'}`,
          },
        ];

      case 'vlan.setPvid':
        // mib-reference.md: Q-BRIDGE-MIB::dot1qPvid confirmed Read-Write,
        // first-hand from Extreme's own EXOS 30.6 User Guide.
        return [
          {
            oid: '1.3.6.1.2.1.17.7.1.4.5.1.1.<ifIndex>', // dot1qPortVlanTable::dot1qPvid.<ifIndex>
            type: 'Integer',
            value: action.vlanId,
            description: `Q-BRIDGE-MIB::dot1qPvid.<ifIndex> = ${action.vlanId}`,
          },
        ];

      case 'vlan.create':
        // dot1qVlanStaticRowStatus confirmed Read-Create, but EXOS only
        // implements createAndGo(4)/destroy(6) — no real two-phase create.
        // dot1qVlanStaticName set alongside, mirroring the multi-op pattern
        // Cisco's config.save uses for a row-creation SET.
        return [
          {
            oid: `1.3.6.1.2.1.17.7.1.4.3.1.5.${action.vlanId}`, // dot1qVlanStaticTable::dot1qVlanStaticRowStatus.<vlanId>
            type: 'RowStatus',
            value: 4,
            description: `Q-BRIDGE-MIB::dot1qVlanStaticRowStatus.${action.vlanId} = createAndGo(4) — EXOS only implements createAndGo/destroy, not full 2-phase RowStatus`,
          },
          {
            oid: `1.3.6.1.2.1.17.7.1.4.3.1.1.${action.vlanId}`, // dot1qVlanStaticName.<vlanId>
            type: 'OctetString',
            value: action.name,
            description: `Q-BRIDGE-MIB::dot1qVlanStaticName.${action.vlanId} = "${action.name}"`,
          },
        ];

      case 'config.save':
        // EXTREME-SYSTEM-MIB::extremeSaveConfiguration — mib-reference.md
        // flags this OID as third-party-mirror-sourced, "provisional",
        // not independently confirmed against Extreme's own MIB text.
        return [
          {
            oid: '1.3.6.1.4.1.1916.1.1.1.1.3',
            type: 'Integer',
            value: 1,
            description:
              'EXTREME-SYSTEM-MIB::extremeSaveConfiguration (provisional OID, third-party-mirror-sourced per mib-reference.md — not independently confirmed against Extreme\'s own MIB text) = save-trigger(1)',
          },
        ];

      // port.setDescription, vlan.setTrunkAllowed (read-modify-write safety,
      // see class doc comment), interface.setIpAddress, route.static.upsert:
      // no confirmed-safe SNMP write path per overview.md's explicit
      // write-scope table — CLI-only, correctly returning null.
      default:
        return null;
    }
  }

  buildReadbackCommand(action: DeviceAction): string | null {
    switch (action.kind) {
      case 'port.setAdminStatus':
      case 'port.setDescription':
        return `show ports ${action.interfaceName} information`;
      case 'vlan.setPvid':
      case 'vlan.setTrunkAllowed':
        return `show ports ${action.interfaceName} vlan`;
      case 'vlan.create':
        return 'show vlan';
      default:
        return null;
    }
  }

  parseReadback(action: DeviceAction, rawOutput: string): StructuredDiff {
    // Intentionally minimal this phase, matching cisco-ios.adapter.ts's
    // level of effort — no literal sample `show` output exists in
    // cli-reference.md (docs cover command syntax, not example output), so
    // this parses a plausible representative EXOS-shaped output rather
    // than a doc-confirmed one; the CLI-stub script's fixtures below are
    // this parser's actual round-trip contract, not a vendor transcription.
    if (action.kind === 'port.setAdminStatus') {
      const adminMatch = rawOutput.match(/Admin State:\s*(Enabled|Disabled)/i);
      const linkMatch = rawOutput.match(/Link State:\s*(\w+)/i);
      return {
        changed: true,
        after: { adminUp: adminMatch?.[1]?.toLowerCase() === 'enabled', operUp: linkMatch?.[1]?.toLowerCase() === 'active' },
        note: rawOutput.slice(0, 400),
      };
    }
    if (action.kind === 'port.setDescription') {
      const match = rawOutput.match(/Description:\s*(.*)/i);
      return { changed: true, after: match?.[1]?.trim(), note: rawOutput.slice(0, 400) };
    }
    return { changed: true, after: rawOutput.slice(0, 400) };
  }
}
