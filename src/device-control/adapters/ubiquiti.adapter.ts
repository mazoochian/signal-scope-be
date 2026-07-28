import {
  CliDialect,
  DeviceAction,
  SnmpSetOp,
  StructuredDiff,
  VendorAdapter,
} from './vendor-adapter.interface';

/**
 * Ubiquiti (UniFi switches) — direct-device CLI adapter, transcribed from
 * signal-scope-docs/vendors/ubiquiti/overview.md and the Ubiquiti rows of
 * comparison/{cli-syntax-matrix,snmp-write-support-matrix}.md.
 *
 * ============================================================================
 * IMPORTANT — READ BEFORE USING THIS ADAPTER: this is the one vendor in the
 * project where a successful buildCliPlan() round trip does NOT mean the
 * change is durable. UniFi switches are controller-first: the UniFi Network
 * Controller treats its own stored config as authoritative and pushes it back
 * down on the switch's next reboot or re-provisioning cycle, SILENTLY
 * DISCARDING anything typed directly on the device in the meantime. A caller
 * that applies an action through this adapter and later reads back success
 * should not assume the change survives past the next provisioning cycle —
 * see overview.md's "Why controller-first" section. The UniFi Network
 * Controller API (official or legacy REST) is the durable integration point
 * for this vendor; this adapter exists for the secondary, non-durable direct
 * path only (documented per this project's per-vendor CLI-adapter parity, not
 * because it's the recommended way to manage UniFi fleets).
 * ============================================================================
 *
 * Session-establishment quirk unique to this vendor: SSH does not land on
 * the switch CLI directly — it drops into a Linux shell, from which the
 * actual EdgeSwitch/FASTPATH-derived CLI is reached via `telnet 127.0.0.1`
 * then `enable`. Modeled below as `enableSequence` since it plays the same
 * "commands to reach privileged/config-capable mode" role that a plain
 * `enable` line does for Cisco/Arista.
 *
 * SNMP: UBNT-MIB.txt (2,301 lines, full read) contains zero
 * MAX-ACCESS read-write objects — buildSnmpPlan is correctly null for every
 * action, a confirmed negative finding, not an unresearched gap.
 *
 * CLI coverage is deliberately partial: overview.md's curated CLI table only
 * documents VLAN participation/tagging/pvid, frame-acceptance policy, and
 * `show running-config` — it does not document a port description command,
 * VLAN creation command, IP addressing, or static routing syntax for this
 * vendor, and the exact port admin-state keyword is explicitly flagged
 * "not independently confirmed this session". Per this project's discipline
 * of never inventing vendor syntax, actions with no documented command
 * return null rather than guessing. port.setAdminStatus and the interface
 * exit command below use `shutdown`/`no shutdown`/`exit`, consistent with
 * cli-syntax-matrix.md's own characterization of this CLI as
 * "IOS-adjacent" — but per that same file this is an assumption, not a
 * confirmed keyword, and is seeded into vendor_capability_defaults at
 * 'assumed' (not 'confirmed') confidence accordingly.
 */
export class UbiquitiAdapter implements VendorAdapter {
  readonly profileId = 'ubiquiti';
  // FASTPATH-style <unit>/<port>, e.g. "0/1" — overview.md curated CLI table.
  readonly interfaceNamePattern = /^[0-9]+\/[0-9]+$/;

  readonly cliDialect: CliDialect = {
    promptPatterns: {
      exec: /\S+>\s*$/,
      privileged: /\S+#\s*$/,
      config: /\S+\(config\)#\s*$/,
      'config-if': /\S+\(config-if\)#\s*$/,
    },
    // Not documented in overview.md — no pagination command is mentioned for
    // this vendor's CLI; left null rather than assumed from another vendor.
    pagingDisableCmd: null,
    // SSH lands in a Linux shell; the switch's own EdgeSwitch/FASTPATH CLI is
    // reached by telnetting to localhost from within that shell, then
    // `enable` for privileged mode — see class doc comment.
    enableSequence: ['telnet 127.0.0.1', 'enable'],
    // overview.md: VLAN config uses distinct verbs (participation
    // include/exclude vs. tagging) rather than a negation particle
    // prepended to one verb — not a single negation keyword.
    negationKeyword: null,
    // "The one vendor in this project where 'Save' as a GUI concept doesn't
    // map to a device-side action at all" — the controller is always the
    // durable target; there is no device-side persist/commit command.
    saveOrCommit: { kind: 'none', commands: [] },
    candidateConfig: false,
  };

  buildCliPlan(action: DeviceAction): string[] | null {
    switch (action.kind) {
      case 'port.setAdminStatus':
        // Assumed IOS-adjacent keyword — see class doc comment. Exact
        // FASTPATH keyword not independently confirmed in overview.md.
        return [
          'configure',
          `interface ${action.interfaceName}`,
          action.adminStatus === 'up' ? 'no shutdown' : 'shutdown',
          'exit',
        ];

      case 'vlan.setPvid':
        // Native/untagged VLAN assignment: make the port a member of the
        // VLAN (participation) and set it as the port's PVID — the two
        // curated-table commands that together are the closest analogue to
        // Cisco's "switchport access vlan <n>".
        return [
          'configure',
          `interface ${action.interfaceName}`,
          `vlan participation include ${action.vlanId}`,
          `vlan pvid ${action.vlanId}`,
          'exit',
        ];

      case 'vlan.setTrunkAllowed':
        // Membership (participation) and tagged-transmission (tagging) are
        // separate steps on this CLI family, per overview.md — unlike
        // Cisco's single "switchport trunk allowed vlan" command. Comma-
        // joined VLAN list assumed accepted by both commands, consistent
        // with the reference FASTPATH dialect's general list syntax
        // elsewhere in this project's Netgear findings (not independently
        // re-confirmed for Ubiquiti specifically this session).
        return [
          'configure',
          `interface ${action.interfaceName}`,
          `vlan participation include ${action.vlanIds.join(',')}`,
          `vlan tagging ${action.vlanIds.join(',')}`,
          'exit',
        ];

      // port.setDescription, vlan.create, config.save, interface.setIpAddress,
      // route.static.upsert: no command documented in overview.md's curated
      // CLI table for any of these — correctly null rather than invented.
      // config.save specifically is a confirmed "N/A / actively discouraged"
      // finding (see class doc comment), not an unresearched gap.
      default:
        return null;
    }
  }

  buildSnmpPlan(_action: DeviceAction): SnmpSetOp[] | null {
    // UBNT-MIB.txt read in full (2,301 lines): zero MAX-ACCESS read-write
    // objects across every product group covered. Confirmed negative finding
    // for every action in this phase's DeviceAction set.
    return null;
  }

  buildReadbackCommand(action: DeviceAction): string | null {
    switch (action.kind) {
      case 'port.setAdminStatus':
      case 'vlan.setPvid':
      case 'vlan.setTrunkAllowed':
        // The only readback command overview.md's curated CLI table
        // documents for this vendor.
        return 'show running-config';
      default:
        return null;
    }
  }

  parseReadback(action: DeviceAction, rawOutput: string): StructuredDiff {
    // Intentionally minimal this phase, matching cisco-ios.adapter.ts's
    // level of effort — enough to confirm the round trip against
    // `show running-config` output, not a full config parser.
    if (action.kind === 'port.setAdminStatus') {
      const ifBlock = extractInterfaceBlock(rawOutput, action.interfaceName);
      const adminUp = !/(^|\n)\s*shutdown\s*($|\n)/.test(ifBlock);
      return { changed: true, after: { adminUp }, note: rawOutput.slice(0, 400) };
    }
    if (action.kind === 'vlan.setPvid') {
      const ifBlock = extractInterfaceBlock(rawOutput, action.interfaceName);
      const match = ifBlock.match(/vlan pvid (\d+)/);
      return { changed: true, after: match ? Number(match[1]) : undefined, note: rawOutput.slice(0, 400) };
    }
    if (action.kind === 'vlan.setTrunkAllowed') {
      const ifBlock = extractInterfaceBlock(rawOutput, action.interfaceName);
      const match = ifBlock.match(/vlan tagging ([\d,]+)/);
      return {
        changed: true,
        after: match ? match[1].split(',').map(Number) : undefined,
        note: rawOutput.slice(0, 400),
      };
    }
    return { changed: true, after: rawOutput.slice(0, 400) };
  }
}

function extractInterfaceBlock(rawOutput: string, interfaceName: string): string {
  const marker = `interface ${interfaceName}`;
  const start = rawOutput.indexOf(marker);
  if (start === -1) return '';
  const rest = rawOutput.slice(start + marker.length);
  const nextInterface = rest.search(/\ninterface\s+\S+/);
  return nextInterface === -1 ? rest : rest.slice(0, nextInterface);
}
