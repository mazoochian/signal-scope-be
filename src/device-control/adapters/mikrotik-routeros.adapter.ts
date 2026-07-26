import {
  CliDialect,
  DeviceAction,
  SnmpSetOp,
  StructuredDiff,
  VendorAdapter,
} from './vendor-adapter.interface';

/**
 * MikroTik RouterOS — structurally the most different vendor of the four
 * this phase implements. Every command line below is transcribed directly
 * from signal-scope-docs/vendors/mikrotik/{overview,cli-reference,
 * gui-cli-snmp-mapping,mib-reference}.md except where a specific inline
 * comment flags a best-effort extrapolation (the docs tree does not cover
 * every action in this phase's DeviceAction set for this vendor — see the
 * `interface.setIpAddress`/`route.static.upsert`/`vlan.setTrunkAllowed`/
 * `vlan.create` cases below).
 *
 * Do NOT pattern-match cisco-ios.adapter.ts's mode-based shape here.
 * RouterOS has no EXEC/config-mode split at all: every command is a
 * complete, self-contained, fully-qualified menu-path line
 * (`/interface disable ether1`) whether issued from `/` or after `cd`-ing
 * into a menu level — there is no "enter a context, issue bare commands,
 * exit" sequence the way Cisco/Juniper/Arista/Aruba require. Accordingly
 * buildCliPlan() below returns a SINGLE line per action, not a multi-line
 * mode-entry sequence. See overview.md's "CLI dialect / platform scope"
 * section and cli-syntax-matrix.md's "Mode/context model" row.
 */
export class MikrotikRouterosAdapter implements VendorAdapter {
  readonly profileId = 'mikrotik-routeros';

  // Free-text name, either factory-default (ether1) or user-renamed via
  // `/interface set ether1 name=uplink-core1` — not a fixed positional
  // scheme like Cisco's <Type><slot>/<port>. Kept permissive per
  // cli-syntax-matrix.md's "Interface naming scheme" row.
  readonly interfaceNamePattern = /^[A-Za-z0-9_-]+$/;

  readonly cliDialect: CliDialect = {
    // RouterOS has no EXEC/privileged/config split — the session is always
    // in the same single "mode" from the session-tracker's perspective, so
    // one prompt pattern covers it. Prompt shape confirmed by
    // overview.md's example: `[admin@MikroTik] /interface bridge>` (shown
    // while cd'd into a menu level) / `[admin@MikroTik] >` at the root.
    promptPatterns: {
      exec: /\[\S+@\S+\]\s*(\/\S.*)?>\s*$/,
    },
    // RouterOS console output is not paginated the way EXEC-style CLIs are
    // — cli-syntax-matrix.md's "Output paging" row, confirmed N/A for this
    // vendor.
    pagingDisableCmd: null,
    // No enable/privileged step — cli-syntax-matrix.md's "Separate enable
    // step" row is "No" for MikroTik.
    enableSequence: null,
    // disable/enable/remove are verbs themselves, not a negation particle
    // prepended to another verb (contrast Cisco's `no shutdown`) —
    // cli-syntax-matrix.md's "Negation particle" row.
    negationKeyword: null,
    // No running/startup-config split and no save/commit step at all —
    // every command is durably persisted the instant it runs. This is the
    // one vendor in this project with a categorical "no persistence step
    // exists" — cli-syntax-matrix.md's "Save/persist command" row and
    // gui-cli-snmp-mapping.md's dedicated "Backup/export — not a save
    // action" section. `/system backup save` / `/export` are
    // backup/portability mechanisms, not a prerequisite for a change to
    // survive reboot, so they do not belong here.
    saveOrCommit: { kind: 'none', commands: [] },
    candidateConfig: false,
  };

  buildCliPlan(action: DeviceAction): string[] | null {
    switch (action.kind) {
      case 'port.setAdminStatus':
        // cli-reference.md "Interface admin state and description" table:
        // single self-contained line, no context switch.
        return [action.adminStatus === 'up' ? `/interface enable ${action.interfaceName}` : `/interface disable ${action.interfaceName}`];

      case 'port.setDescription':
        // cli-reference.md: `comment` is RouterOS's ifAlias-equivalent.
        // Quoted since comment text may contain spaces.
        return [`/interface set ${action.interfaceName} comment="${action.description}"`];

      case 'vlan.setPvid':
        // cli-reference.md "Bridge / VLAN configuration" table, v7
        // bridge-VLAN-filtering model (current best practice per that
        // file). Uses RouterOS's `[find ...]` inline-query syntax exactly
        // as documented.
        return [`/interface bridge port set [find interface=${action.interfaceName}] pvid=${action.vlanId}`];

      case 'vlan.setTrunkAllowed':
        // Best-effort mapping, NOT a direct transcription — flagged per
        // the task's instruction since RouterOS's bridge-VLAN model has no
        // single "set the allowed-VLAN list on this port" command the way
        // Cisco's `switchport trunk allowed vlan` is. VLAN membership in
        // RouterOS lives on bridge-vlan TABLE ENTRIES (shared across the
        // bridge), not as a per-port property, and cli-reference.md's
        // examples always include a `bridge=` argument that this
        // DeviceAction has no field for (the action carries interfaceName
        // + vlanIds only, no bridge name). This adapter assumes a single
        // conventional bridge named "bridge1", matching cli-reference.md's
        // own running example and its "single bridge interface per
        // switch" recommendation in the modern-model note — NOT
        // independently confirmed against any specific device's actual
        // bridge name, and will be wrong for any device using a
        // differently-named bridge or the older switch-chip-native VLAN
        // model. cli-reference.md does confirm combining multiple VLAN IDs
        // into one `tagged=` entry is safe when all member ports are
        // tagged (trunk membership always is), so vlanIds are joined into
        // one `add` call rather than one call per VLAN. Also note: this
        // uses `add`, which creates a NEW bridge-vlan entry each time —
        // cli-reference.md separately documents `/interface bridge vlan
        // set [find vlan-ids=N] tagged=...` for updating an EXISTING
        // entry, but choosing between add/set requires a prior read of
        // `/interface bridge vlan print` this adapter's pure
        // buildCliPlan() has no access to. Re-running this action against
        // a port that already has a bridge-vlan entry for the same VLAN
        // IDs will create a duplicate/conflicting entry on a real device —
        // a known limitation, not silently glossed over.
        return [`/interface bridge vlan add bridge=bridge1 tagged=${action.interfaceName} vlan-ids=${action.vlanIds.join(',')}`];

      case 'vlan.create':
        // Best-effort mapping, NOT a direct transcription — flagged. The
        // v7 bridge-VLAN-filtering model (cli-reference.md) has no
        // standalone "VLAN database" object the way Cisco's `vlan
        // <id>/name <name>` does; the closest equivalent is adding a
        // bridge-vlan table entry, but that entry has no documented `name`
        // field. `comment=` is a generic property present on nearly every
        // RouterOS `add`/`set` command for a free-text human label;
        // reusing it to carry this action's `name` field is a plausible
        // best-effort mapping but is NOT independently confirmed against
        // cli-reference.md specifically for `/interface bridge vlan add`
        // (comment= is documented elsewhere in the RouterOS CLI, not
        // called out for this exact command in the vendored docs). Same
        // "bridge1" assumption as vlan.setTrunkAllowed above applies here
        // too. No member ports are attached by this action alone — a
        // separate vlan.setPvid/vlan.setTrunkAllowed action supplies port
        // membership.
        return [`/interface bridge vlan add bridge=bridge1 vlan-ids=${action.vlanId} comment="${action.name}"`];

      case 'config.save':
        // Per vendor-adapter.interface.ts: buildCliPlan should return null
        // only when "this vendor has no CLI path for the action at all."
        // That is NOT the case here — config.save is a fully meaningful,
        // well-understood action on RouterOS, its correct CLI plan is just
        // zero commands, because every prior command already persisted
        // durably the instant it ran (cliDialect.saveOrCommit = { kind:
        // 'none', commands: [] }, per overview.md's "Config-apply model"
        // section). Returning [] communicates "a plan exists and it is
        // empty" — a materially different signal for the action
        // runner/audit log than null's "no plan exists for this
        // vendor+action," even though both are falsy-ish to a naive
        // caller. Returning null here would incorrectly suggest
        // config.save is unsupported on this vendor, when the true
        // behavior is "already done, nothing to send."
        return [];

      case 'interface.setIpAddress':
        // NOT covered by the vendored docs tree — cli-reference.md and
        // gui-cli-snmp-mapping.md only mention "/ip address" once, in
        // passing, as an example menu-path name (overview.md line 7); no
        // file in signal-scope-docs/vendors/mikrotik/ documents the exact
        // `/ip address add` syntax or its argument names. The line below
        // is standard, well-established RouterOS syntax from general
        // RouterOS knowledge (CIDR-form `address=<ip>/<prefix>` plus
        // `interface=`), not a transcription from this project's docs
        // tree — flagged per the task's instruction rather than presented
        // as sourced. Reasonably high confidence (this exact form is
        // RouterOS's long-stable, universally-documented public syntax)
        // but should be verified against a live device or an updated docs
        // pass before being treated as "confirmed" in the same sense as
        // the rest of this file.
        return [`/ip address add address=${action.ipAddress}/${action.prefixLength} interface=${action.interfaceName}`];

      case 'route.static.upsert':
        // Same caveat as interface.setIpAddress above: NOT covered by the
        // vendored docs tree, standard RouterOS syntax from general
        // knowledge, flagged rather than presented as a transcription.
        // Also note "upsert" is aspirational here: RouterOS's `/ip route
        // add` always creates a new route entry — there is no documented
        // single-line idempotent "update the existing route for this
        // destination" form the way this DeviceAction's name implies.
        // A true upsert would need a prior `/ip route print` read to find
        // and `set` an existing entry by ID, which — like
        // vlan.setTrunkAllowed above — this adapter's pure buildCliPlan()
        // has no access to.
        return [`/ip route add dst-address=${action.destinationCidr} gateway=${action.nextHop}`];

      default:
        return null;
    }
  }

  buildSnmpPlan(_action: DeviceAction): SnmpSetOp[] | null {
    // MikroTik's entire MIKROTIK-MIB module has exactly three
    // MAX-ACCESS read-write objects, confirmed by directly grepping the
    // vendored MIKROTIK-MIB.txt file (mib-reference.md's "Confirmed
    // read-write objects" section): mtxrSystemReboot, mtxrUSBPowerReset,
    // and mtxrScriptRunCmd (a script-execution trigger) — none of them a
    // switch/router configuration object. The only other writable
    // objects on this platform are standard SNMPv2-MIB system-identity
    // scalars (sysName/sysContact/sysLocation). None of the DeviceAction
    // kinds this phase covers (port/VLAN/IP/route config, config.save)
    // maps to any of those — every one of them is confirmed CLI-only per
    // gui-cli-snmp-mapping.md's per-row "CLI-only" notes and its summary:
    // "MikroTik is... one of the two vendors in this project with
    // essentially no confirmed SNMP write path for switch configuration."
    // Unconditionally null rather than a per-kind switch, since there is
    // no kind in this action set with a documented exception.
    return null;
  }

  buildReadbackCommand(action: DeviceAction): string | null {
    switch (action.kind) {
      case 'port.setAdminStatus':
      case 'port.setDescription':
        // cli-reference.md "Read-back / print commands" table documents
        // `/interface print` (bare); `detail` + a `where` filter is
        // RouterOS's standard print-filtering idiom used consistently
        // throughout that same file's other print examples.
        return `/interface print detail where name=${action.interfaceName}`;

      case 'vlan.setPvid':
        // cli-reference.md: "List bridge ports (PVID, frame-types,
        // horizon) | /interface bridge port print detail".
        return `/interface bridge port print detail where interface=${action.interfaceName}`;

      case 'vlan.setTrunkAllowed':
      case 'vlan.create':
        // cli-reference.md: "List bridge VLAN table | /interface bridge
        // vlan print".
        return '/interface bridge vlan print';

      case 'interface.setIpAddress':
        // Not documented in the vendored docs tree (see buildCliPlan's
        // comment on this action) — `/ip address print detail` follows
        // the same print/detail/where idiom as the documented cases
        // above, applied to the `/ip address` menu overview.md names in
        // passing.
        return `/ip address print detail where interface=${action.interfaceName}`;

      case 'route.static.upsert':
        // Same caveat as interface.setIpAddress.
        return `/ip route print detail where dst-address=${action.destinationCidr}`;

      case 'config.save':
        // No CLI plan is ever sent for this action (see buildCliPlan) so
        // there's nothing to read back — matches cisco-ios.adapter.ts's
        // pattern of returning null for config.save.
        return null;

      default:
        return null;
    }
  }

  parseReadback(action: DeviceAction, rawOutput: string): StructuredDiff {
    // Intentionally minimal this phase — deep per-vendor `print` output
    // parsing is a documented fast-follow (see device-control/README.md),
    // matching cisco-ios.adapter.ts's level of effort. Covers the two
    // cases with an easy-to-eyeball text signal; everything else returns
    // the raw text unparsed rather than guessing at a shape.
    if (action.kind === 'port.setAdminStatus') {
      // RouterOS `/interface print` flag column uses `X` for a disabled
      // interface and `R` for running — cli-reference.md's "List
      // interfaces + admin/oper state" row. A disabled interface's detail
      // block typically shows `disabled=yes`.
      const disabled = /disabled=yes/i.test(rawOutput);
      return { changed: true, after: { adminUp: !disabled }, note: rawOutput.slice(0, 400) };
    }
    if (action.kind === 'port.setDescription') {
      const match = rawOutput.match(/comment="([^"]*)"/i);
      return { changed: true, after: match?.[1], note: rawOutput.slice(0, 400) };
    }
    return { changed: true, after: rawOutput.slice(0, 400) };
  }
}
