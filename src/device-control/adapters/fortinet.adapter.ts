import {
  CliDialect,
  DeviceAction,
  SnmpSetOp,
  StructuredDiff,
  VendorAdapter,
} from './vendor-adapter.interface';

/**
 * Fortinet (FortiSwitch) — standalone CLI only. Every command line below is
 * transcribed from signal-scope-docs/vendors/fortinet/overview.md and the
 * Fortinet notes in comparison/cli-syntax-matrix.md.
 *
 * Scope: FortiSwitch units are most commonly deployed FortiLink-managed
 * (administered through a parent FortiGate's `config switch-controller
 * managed-switch` tree — a structurally different "session target != config
 * target" shape, documented separately in
 * signal-scope-docs/vendors/fortinet/fortilink-integration.md). This
 * adapter deliberately covers ONLY the standalone direct-SSH/Telnet CLI
 * path (`config switch ...` on the switch itself). Wiring the FortiLink
 * path needs device_connection_targets.proxy_device_id/proxy_selector
 * routing in the connection/orchestrator layer that doesn't exist yet —
 * that's a real scope-add beyond "one more adapter", explicitly deferred.
 *
 * Grammar: FortiOS/FortiSwitchOS use a stack-based `config <table>` /
 * `edit <entry>` / `set <field> <value>` / `next` / `end` block syntax,
 * not Cisco-style flat line commands — each `config`/`edit` pushes a
 * context, each `next`/`end` pops one.
 *
 * Save semantics (the reason this vendor is interesting): FortiOS applies
 * and persists configuration as soon as the enclosing `config` block's
 * `end` executes — there is no separate "write memory" step. `config.save`
 * therefore has nothing to echo: the `end` that already closes every other
 * action's block IS the save. See `cliDialect.saveOrCommit` below.
 *
 * SNMP: overview.md's own conclusion is to treat FortiSwitch SNMP as
 * CLI-only for config changes — no FortiSwitch-specific documentation this
 * project has found confirms a general SNMP SET path for VLAN membership,
 * port admin-status, or anything else beyond the standard read/trap
 * baseline. `buildSnmpPlan` is null throughout, matching that conclusion.
 *
 * Uncertainty flags carried over from overview.md, not resolved here:
 * the exact field name for per-port admin status (`status` vs. a
 * `physical-port` sub-tree field on some releases), whether `vlan.create`
 * has a real standalone-CLI equivalent (not in the curated table — this
 * adapter's `config switch vlan` guess is unconfirmed), and readback
 * command argument syntax (`get switch physical-port`/`get switch vlan`
 * are named in the docs without a fully worked example). `port.setDescription`
 * is likewise not in the curated CLI table — included here as a low-risk
 * extension (same edit block as the confirmed `native-vlan`/`allowed-vlans`
 * fields) but not independently confirmed. `interface.setIpAddress` and
 * `route.static.upsert` are intentionally NOT implemented (return null) —
 * overview.md's confirmed CLI surface is switch-scoped (port/VLAN/trunk/
 * STP/LACP); FortiSwitch is a switch product and no L3/routing CLI syntax
 * is documented for it in this docs tree, so this adapter doesn't invent
 * FortiGate-router syntax for a switch platform.
 */
export class FortinetAdapter implements VendorAdapter {
  readonly profileId = 'fortinet';
  // FortiSwitch physical port naming, e.g. "port5" — overview.md's `edit "port5"` example.
  readonly interfaceNamePattern = /^port[0-9]+$/;

  readonly cliDialect: CliDialect = {
    promptPatterns: {
      exec: /^\S+\s*#\s*$/,
      config: /^\S+\s*\([\w.-]+\)\s*#\s*$/,
      'config-if': /^\S+\s*\("[^"]+"\)\s*#\s*$/,
    },
    // Not documented in overview.md — no paging-disable command is named for
    // FortiSwitch (unlike FortiGate's `config system console` / `set output
    // standard`, not part of this vendor's confirmed surface). Left null
    // rather than assumed.
    pagingDisableCmd: null,
    // No separate privileged-mode step — a single admin CLI level from login.
    enableSequence: null,
    // Not a true single-particle negation the way Cisco's `no`/Huawei's `undo`
    // are — FortiOS resets a field with `unset <field>` or removes a whole
    // edit-entry with `delete <entry>`. Closest single-token analog is
    // `unset`, flagged the same way juniper-junos.adapter.ts flags `delete`.
    negationKeyword: 'unset',
    saveOrCommit: { kind: 'none', commands: [] },
    candidateConfig: false,
  };

  buildCliPlan(action: DeviceAction): string[] | null {
    switch (action.kind) {
      case 'port.setAdminStatus':
        // Curated table: "Field name is `status`, not `admin-status`;
        // confirm exact field name against the version-specific reference —
        // some releases expose this under `config switch physical-port`
        // instead."
        return [
          'config switch interface',
          `edit "${action.interfaceName}"`,
          `set status ${action.adminStatus === 'up' ? 'up' : 'down'}`,
          'next',
          'end',
        ];

      case 'port.setDescription':
        // Not in overview.md's curated table — same edit block as the
        // confirmed native-vlan/allowed-vlans fields, low-risk extension,
        // not independently confirmed this session.
        return [
          'config switch interface',
          `edit "${action.interfaceName}"`,
          `set description "${action.description}"`,
          'next',
          'end',
        ];

      case 'vlan.setPvid':
        // Confirmed: native-vlan is the untagged/PVID field, distinct from
        // the tagged allowed-vlans set.
        return [
          'config switch interface',
          `edit "${action.interfaceName}"`,
          `set native-vlan ${action.vlanId}`,
          'next',
          'end',
        ];

      case 'vlan.setTrunkAllowed':
        // Confirmed: allowed-vlans takes a comma-separated list/range.
        return [
          'config switch interface',
          `edit "${action.interfaceName}"`,
          `set allowed-vlans ${action.vlanIds.join(',')}`,
          'next',
          'end',
        ];

      case 'vlan.create':
        // Not in overview.md's curated table (which only covers per-port
        // VLAN membership, not VLAN-object creation) — `config switch vlan`
        // is the FortiOS convention for a switch-side VLAN table but is not
        // independently confirmed against this docs tree's sources.
        return ['config switch vlan', `edit ${action.vlanId}`, `set name "${action.name}"`, 'next', 'end'];

      case 'config.save':
        // See class doc comment: `end` (already the last line of every
        // other action's plan) persists immediately — there is nothing
        // separate to send. Returning null, not an empty command list, to
        // signal "no distinct CLI path for this concept on Fortinet" rather
        // than "a no-op plan".
        return null;

      // interface.setIpAddress / route.static.upsert: FortiSwitch's
      // confirmed CLI surface in this docs tree is switch-scoped
      // (port/VLAN/trunk/STP/LACP) — no L3/routing syntax is documented for
      // this vendor, so these correctly return null rather than borrowing
      // FortiGate router syntax for a switch platform.
      default:
        return null;
    }
  }

  buildSnmpPlan(_action: DeviceAction): SnmpSetOp[] | null {
    // overview.md's explicit conclusion: "SignalScope should assume
    // CLI-only for config changes on Fortinet devices unless a specific
    // object is separately confirmed live." No FortiSwitch-specific SNMP
    // write path has been confirmed for any action in this phase's set —
    // correctly null throughout.
    return null;
  }

  buildReadbackCommand(action: DeviceAction): string | null {
    switch (action.kind) {
      case 'port.setAdminStatus':
      case 'port.setDescription':
        // Curated table's read-back column names "get switch physical-port"
        // without a fully worked argument example — filtering by port name
        // here is the natural reading, not independently confirmed.
        return `get switch physical-port ${action.interfaceName}`;
      case 'vlan.setPvid':
      case 'vlan.setTrunkAllowed':
      case 'vlan.create':
        return 'get switch vlan';
      case 'interface.setIpAddress':
      case 'route.static.upsert':
      case 'config.save':
        return null;
      default:
        return null;
    }
  }

  parseReadback(action: DeviceAction, rawOutput: string): StructuredDiff {
    // Intentionally minimal this phase, matching the other adapters' level
    // of effort — enough to confirm a round trip, not a full `get`-output
    // parser for undocumented FortiOS field layouts.
    if (action.kind === 'port.setAdminStatus') {
      const match = rawOutput.match(/status:\s*(up|down)/i);
      return { changed: true, after: { adminUp: match?.[1]?.toLowerCase() === 'up' }, note: rawOutput.slice(0, 400) };
    }
    if (action.kind === 'port.setDescription') {
      const match = rawOutput.match(/description:\s*"?([^"\r\n]*)"?/i);
      return { changed: true, after: match?.[1]?.trim(), note: rawOutput.slice(0, 400) };
    }
    return { changed: true, after: rawOutput.slice(0, 400) };
  }
}
