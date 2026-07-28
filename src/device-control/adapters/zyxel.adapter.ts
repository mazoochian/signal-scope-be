import {
  CliDialect,
  DeviceAction,
  SnmpSetOp,
  StructuredDiff,
  VendorAdapter,
} from './vendor-adapter.interface';

/**
 * Zyxel — the most CLI-constrained vendor in this project's docs tree.
 * Transcribed from signal-scope-docs/vendors/zyxel/overview.md and the
 * Zyxel rows of comparison/{cli-syntax-matrix.md,snmp-write-support-matrix.md}
 * (appendix-tier, extended-comparison sections).
 *
 * Zyxel has real product-line fragmentation: the GS1900 ("Smart Managed")
 * line has NO config-write CLI path at all (`configure terminal` returns
 * "Unknown command", confirmed directly, not inferred) — only the
 * standalone-managed line (XGS4600/GS19x0/GS2210/GS3700) has a real CLI,
 * and this adapter's `profileId='zyxel'` targets that line only (a
 * device on the GS1900 line should never be assigned this profile with
 * CLI as its transport — that's a device_connection_targets/capability-
 * detection concern, same pattern as Netgear's GS-series split).
 *
 * Even for the standalone-managed line, only a narrow slice of syntax is
 * independently confirmed: `configure` (not `configure terminal`) enters
 * config mode, `vlan <n>` creates/enters a VLAN, and `write memory`
 * persists. Port enable/disable keyword, physical-interface naming
 * convention, and per-interface VLAN (PVID) assignment outside the
 * `interface port-channel <n>` case are all explicitly flagged
 * "not independently confirmed this session" in the docs — this adapter
 * does not invent syntax to fill those gaps, so `buildCliPlan` returns
 * `null` for every action beyond the two genuinely confirmed ones
 * (`vlan.create`'s VLAN-id creation step, and `config.save`).
 *
 * SNMP write status is itself unresolved in the docs for both product
 * tiers (every cell in the appendix comparison table is "—", not even
 * ⚠️) — every `buildSnmpPlan` branch returns `null`. A future capability-
 * seed migration for this vendor should use `'unknown'` confidence
 * throughout, not `'confirmed'`/`'assumed'`, since nothing here has been
 * independently verified.
 */
export class ZyxelAdapter implements VendorAdapter {
  readonly profileId = 'zyxel';
  // Interface naming convention (bare port number vs. `port <n>` vs.
  // slot/port scheme) was not independently confirmed this session —
  // kept permissive rather than guessing a specific scheme.
  readonly interfaceNamePattern = /^.+$/;

  readonly cliDialect: CliDialect = {
    promptPatterns: {
      exec: /\S+>\s*$/,
      config: /\S+\(config\)#\s*$/,
    },
    // Not confirmed for this vendor — left null rather than assumed.
    pagingDisableCmd: null,
    // No separate enable/privileged step is documented — `configure`
    // is described as reachable directly.
    enableSequence: null,
    // Not independently confirmed this session.
    negationKeyword: null,
    // `write memory` is confirmed — same shorthand-save convention as
    // Cisco/Arista/Dell OS10.
    saveOrCommit: { kind: 'persist', commands: ['write memory'] },
    candidateConfig: false,
  };

  buildCliPlan(action: DeviceAction): string[] | null {
    switch (action.kind) {
      case 'vlan.create':
        // Only the VLAN-id creation step is confirmed
        // (`configure` -> `vlan <n>`) — no confirmed `name` sub-command
        // for this vendor, so action.name is intentionally not used here
        // rather than guessing at a naming syntax.
        return ['configure', `vlan ${action.vlanId}`];

      case 'config.save':
        return [this.cliDialect.saveOrCommit.commands[0]];

      // port.setAdminStatus / port.setDescription: enable-disable keyword
      // and interface naming are both unconfirmed.
      // vlan.setPvid / vlan.setTrunkAllowed: PVID assignment is only
      // confirmed inside an `interface port-channel <n>` context, which
      // doesn't generalize to an arbitrary interfaceName — applying it
      // unconditionally would misrepresent an unconfirmed general case
      // as confirmed syntax.
      // interface.setIpAddress / route.static.upsert: no L3 CLI content
      // documented for this vendor at all.
      default:
        return null;
    }
  }

  buildSnmpPlan(_action: DeviceAction): SnmpSetOp[] | null {
    // SNMP write scope is unresolved in the docs for both product tiers
    // (every action row is "—", not even a plausible-but-unconfirmed ⚠️)
    // — correctly null for everything rather than guessing at OIDs.
    return null;
  }

  buildReadbackCommand(action: DeviceAction): string | null {
    switch (action.kind) {
      case 'vlan.create':
        // `show running-config` is confirmed to exist as a read-back
        // command (it's the one command confirmed to work even on the
        // CLI-config-locked GS1900 tier).
        return 'show running-config';
      default:
        return null;
    }
  }

  parseReadback(action: DeviceAction, rawOutput: string): StructuredDiff {
    // Intentionally minimal, matching the other adapters' level of effort
    // this phase — enough to confirm the one round trip this adapter
    // actually exercises.
    if (action.kind === 'vlan.create') {
      const present = new RegExp(`(^|\\s)vlan ${action.vlanId}(\\s|$)`, 'im').test(rawOutput);
      return { changed: present, after: present ? { vlanId: action.vlanId } : undefined, note: rawOutput.slice(0, 400) };
    }
    return { changed: false, note: 'zyxel adapter has no readback parsing for this action', after: rawOutput.slice(0, 400) };
  }
}
