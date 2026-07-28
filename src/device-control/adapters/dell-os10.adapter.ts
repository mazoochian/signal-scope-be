import {
  CliDialect,
  DeviceAction,
  SnmpSetOp,
  StructuredDiff,
  VendorAdapter,
} from './vendor-adapter.interface';

/**
 * Dell PowerSwitch — SmartFabric OS10. Every command line below is
 * transcribed from signal-scope-docs/vendors/dell/{overview,cli-reference}.md
 * — OS10 only (not OS9/FTOS, not N-Series DNOS 6.x, per overview.md's
 * three-unrelated-OS warning).
 *
 * CLI-apply model: this adapter targets OS10's DEFAULT immediate-apply mode
 * only (configure terminal -> command -> exit, live as each line is
 * entered — same shape as cisco-ios.adapter.ts). OS10 also supports a
 * separate, opt-in "transaction" candidate-config mode entered via
 * `start transaction` *before* `configure terminal` (see overview.md's
 * config-apply-model section) — deliberately NOT modeled here, for the same
 * reason juniper-junos.adapter.ts's class doc comment gives for Junos's
 * mandatory candidate/commit: this module's worker model runs each
 * DeviceAction as its own fresh dial/session, so a staged `set`-then-later
 * `commit` split across two separate sessions is a real risk (a concurrent
 * session's `discard`, or the transaction simply never being entered by a
 * later job, silently drops the earlier "staged" work). OS10's transaction
 * mode is strictly opt-in per session (unlike Junos, where it's the only
 * way to change config at all) — since immediate-apply is the vendor
 * default and avoids this tension entirely, that's what this adapter uses.
 *
 * No `end`-style single-command return to top level is confirmed for OS10
 * (cli-reference.md only documents single-level `exit`) — every action
 * below issues one `exit` per nested context entered, rather than assuming
 * a Cisco-style shortcut exists.
 */
export class DellOs10Adapter implements VendorAdapter {
  readonly profileId = 'dell-os10';
  // <node>/<slot>/<port> after the `ethernet` keyword, e.g. "ethernet 1/1/2" — cli-reference.md
  readonly interfaceNamePattern = /^ethernet \d+\/\d+\/\d+$/;

  readonly cliDialect: CliDialect = {
    promptPatterns: {
      exec: /\S+#\s*$/,
      config: /\S+\(config\)#\s*$/,
      'config-if': /\S+\(config-if[^)]*\)#\s*$/,
    },
    // Session-wide paging-disable syntax not independently confirmed this
    // session (cli-reference.md: only a per-command `| no-more` pipe filter
    // is confirmed, structurally different from every other vendor's
    // one-time session-start toggle) — null rather than guessing.
    pagingDisableCmd: null,
    // No separate enable step confirmed — `configure terminal` is reached
    // directly, per cli-reference.md's mode-entry table.
    enableSequence: null,
    negationKeyword: 'no',
    saveOrCommit: { kind: 'persist', commands: ['write memory'] },
    candidateConfig: false,
  };

  buildCliPlan(action: DeviceAction): string[] | null {
    switch (action.kind) {
      case 'port.setAdminStatus':
        return [
          'configure terminal',
          `interface ${action.interfaceName}`,
          action.adminStatus === 'up' ? 'no shutdown' : 'shutdown',
          'exit',
          'exit',
        ];

      case 'port.setDescription':
        // cli-reference.md: not independently re-confirmed this session,
        // inferred from the IOS-like pattern the rest of this dialect uses.
        return [
          'configure terminal',
          `interface ${action.interfaceName}`,
          `description ${action.description}`,
          'exit',
          'exit',
        ];

      case 'vlan.setPvid':
        // cli-reference.md: OS10's `switchport access vlan <id>` sets the
        // port's untagged/native VLAN directly — Dell's own trunk-mode
        // example issues it alongside `switchport mode trunk`, i.e. it is
        // NOT an access-mode toggle the way Cisco's identically-named
        // command is. No separate "enter access mode" step is documented,
        // so none is issued here.
        return [
          'configure terminal',
          `interface ${action.interfaceName}`,
          `switchport access vlan ${action.vlanId}`,
          'exit',
          'exit',
        ];

      case 'vlan.setTrunkAllowed':
        return [
          'configure terminal',
          `interface ${action.interfaceName}`,
          'switchport mode trunk',
          `switchport trunk allowed vlan ${action.vlanIds.join(',')}`,
          'exit',
          'exit',
        ];

      case 'vlan.create':
        // cli-reference.md confirms VLAN creation via `interface vlan <id>`
        // (global config) but documents no separate vlan-naming command for
        // OS10 (unlike Cisco's `vlan <id>` / `name <name>` pair) — the
        // VLAN is created, action.name is not applied to the device.
        return ['configure terminal', `interface vlan ${action.vlanId}`, 'exit', 'exit'];

      case 'config.save':
        return [this.cliDialect.saveOrCommit.commands[0]];

      case 'interface.setIpAddress':
        // Not literally present in cli-reference.md (its interface section
        // covers admin-state/description/VLAN only) — same confidence tier
        // as juniper-junos.adapter.ts's own L3 actions: standard modern-NOS
        // CIDR-form `ip address` syntax, not independently confirmed
        // against OS10 documentation this session.
        return [
          'configure terminal',
          `interface ${action.interfaceName}`,
          `ip address ${action.ipAddress}/${action.prefixLength}`,
          'exit',
          'exit',
        ];

      case 'route.static.upsert':
        // Same confidence caveat as interface.setIpAddress above.
        return ['configure terminal', `ip route ${action.destinationCidr} ${action.nextHop}`, 'exit'];

      default:
        return null;
    }
  }

  buildSnmpPlan(_action: DeviceAction): SnmpSetOp[] | null {
    // overview.md's Phase 2 (2026-07-22) first-hand read of the complete
    // SmartFabric OS10 User Guide SNMP/MIBs chapter is unambiguous: OS10
    // ships exactly five DELLEMC-OS10-*-MIB modules, none of them a
    // configuration-action MIB analogous to Cisco's
    // CISCO-VLAN-MEMBERSHIP-MIB/CISCO-CONFIG-COPY-MIB or Aruba's
    // ARUBAWIRED-*-MIB family. No OS10-specific documentation confirms the
    // agent honors a SET on the standard IF-MIB::ifAdminStatus or
    // Q-BRIDGE-MIB::dot1qPvid objects either — a verified-absence finding,
    // not a research gap. Correctly null for every action.
    return null;
  }

  buildReadbackCommand(action: DeviceAction): string | null {
    // cli-reference.md's confirmed Show-commands table has no per-interface
    // or per-VLAN scoped view for OS10 (only the whole `show
    // running-configuration`, LACP, port-security, and SNMP show commands
    // are confirmed) — every readback below uses the whole running config
    // rather than inventing a scoped variant.
    switch (action.kind) {
      case 'port.setAdminStatus':
      case 'port.setDescription':
      case 'vlan.setPvid':
      case 'vlan.setTrunkAllowed':
      case 'vlan.create':
      case 'interface.setIpAddress':
      case 'route.static.upsert':
        return 'show running-configuration';
      case 'config.save':
        return null;
      default:
        return null;
    }
  }

  parseReadback(action: DeviceAction, rawOutput: string): StructuredDiff {
    // Intentionally minimal this phase, matching cisco-ios.adapter.ts's
    // level of effort. Readback is the whole running config, so parsing
    // scopes down to the action's own interface block first.
    if (action.kind === 'port.setAdminStatus' || action.kind === 'port.setDescription') {
      const blockMatch = rawOutput.match(
        new RegExp(`interface ${escapeRegex(action.interfaceName)}[\\s\\S]*?(?=\\ninterface |\\n!|$)`),
      );
      const block = blockMatch?.[0] ?? '';
      if (action.kind === 'port.setAdminStatus') {
        const adminUp = !/\bshutdown\b/.test(block) || /\bno shutdown\b/.test(block);
        return { changed: true, after: { adminUp }, note: block.slice(0, 400) };
      }
      const descMatch = block.match(/description\s+(.*)/);
      return { changed: true, after: descMatch?.[1]?.trim(), note: block.slice(0, 400) };
    }
    return { changed: true, after: rawOutput.slice(0, 400) };
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
