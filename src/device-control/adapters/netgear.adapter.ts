import {
  CliDialect,
  DeviceAction,
  SnmpSetOp,
  StructuredDiff,
  VendorAdapter,
} from './vendor-adapter.interface';

/**
 * Netgear (ProSAFE M-series / "Intelligent Edge" — M4100/M4200/M4300/M5xxx).
 * Transcribed from signal-scope-docs/vendors/netgear/overview.md and the
 * Netgear row of comparison/{cli-syntax-matrix,snmp-write-support-matrix}.md
 * extended-appendix sections.
 *
 * Product-tier fragmentation, not dialect drift: Netgear's "Smart Managed"/
 * GS-series tier has NO officially-supported CLI at all (web GUI only, an
 * unofficial diagnostic-only telnet workaround exists on some models). Only
 * the M-series/Intelligent Edge line has a real, supported CLI — this
 * adapter models that line exclusively. Whether a given Netgear device even
 * has a reachable CLI transport is a capability-detection/connection-target
 * question handled elsewhere in the module, not something this adapter
 * special-cases beyond correctly returning null for anything undocumented.
 *
 * Confirmation is genuinely thin for this vendor (appendix tier,
 * search-summary-sourced): only the config-save command and the
 * `<unit>/<slot>/<port>` interface-naming scheme are independently
 * confirmed. Port enable/disable is "assumed by convention" from the
 * IOS-adjacent shape (cli-syntax-matrix.md rates it Medium confidence).
 * VLAN commands are flagged in the docs as "unconfirmed-by-analogy" (inferred
 * from Ubiquiti's structurally-similar Broadcom-FASTPATH-lineage CLI, not
 * independently confirmed for Netgear) — per this project's standing
 * discipline against inventing command syntax, this adapter does NOT emit a
 * literal VLAN CLI plan; buildCliPlan returns null for those actions rather
 * than a guessed command family. Same reasoning applies to L3 addressing/
 * routing, which isn't documented for this vendor at all.
 */
export class NetgearAdapter implements VendorAdapter {
  readonly profileId = 'netgear';
  // <unit>/<slot>/<port>, confirmed for the M4300, e.g. 1/0/1 — overview.md
  readonly interfaceNamePattern = /^[0-9]+\/[0-9]+\/[0-9]+$/;

  readonly cliDialect: CliDialect = {
    promptPatterns: {
      exec: /\S+>\s*$/,
      privileged: /\S+#\s*$/,
      config: /\S+\(config\)#\s*$/,
      'config-if': /\S+\(config-if\)#\s*$/,
    },
    // Not independently confirmed for Netgear this session — omitted rather
    // than guessed (see class doc comment).
    pagingDisableCmd: null,
    // "Mode-based, IOS-adjacent" per overview.md; enable-mode presence
    // assumed by convention along with the rest of that shape, not
    // independently re-confirmed.
    enableSequence: ['enable'],
    negationKeyword: 'no',
    // The one fully confirmed command in this adapter — distinctive
    // system:/nvram: filesystem-prefix notation, not seen on any other
    // vendor in this project.
    saveOrCommit: { kind: 'persist', commands: ['copy system:running-config nvram:startup-config'] },
    candidateConfig: false,
  };

  buildCliPlan(action: DeviceAction): string[] | null {
    switch (action.kind) {
      case 'port.setAdminStatus':
        // shutdown/no shutdown "presumed by convention" from the
        // IOS-adjacent shape — Medium confidence per cli-syntax-matrix.md,
        // not independently re-confirmed this session.
        return [
          'configure',
          `interface ${action.interfaceName}`,
          action.adminStatus === 'up' ? 'no shutdown' : 'shutdown',
          'exit',
        ];

      case 'port.setDescription':
        return ['configure', `interface ${action.interfaceName}`, `description ${action.description}`, 'exit'];

      case 'config.save':
        return [this.cliDialect.saveOrCommit.commands[0]];

      // vlan.setPvid / vlan.setTrunkAllowed / vlan.create / interface.setIpAddress
      // / route.static.upsert: no independently-confirmed Netgear-specific
      // syntax exists in the docs tree (VLAN command family is flagged
      // "unconfirmed-by-analogy" with Ubiquiti; L3 isn't documented at all)
      // — correctly null rather than invented.
      default:
        return null;
    }
  }

  buildSnmpPlan(_action: DeviceAction): SnmpSetOp[] | null {
    // snmp-write-support-matrix.md's extended-appendix entry for Netgear:
    // "not independently confirmed this session beyond the standard
    // cross-vendor baseline ... treat every action row as at-best
    // unconfirmed, pending specific per-object confirmation." No
    // Netgear-specific SNMP write path is documented for any action in this
    // phase's DeviceAction set — correctly null for everything.
    return null;
  }

  buildReadbackCommand(action: DeviceAction): string | null {
    switch (action.kind) {
      case 'port.setAdminStatus':
      case 'port.setDescription':
        // overview.md's mapping table: "show interface 1/0/1 (exact form
        // not independently confirmed)" — included at the same confidence
        // tier as the write command it verifies.
        return `show interface ${action.interfaceName}`;
      default:
        return null;
    }
  }

  parseReadback(action: DeviceAction, rawOutput: string): StructuredDiff {
    // Intentionally minimal, matching the established per-adapter bar —
    // deep per-vendor `show` parsing is a documented fast-follow.
    if (action.kind === 'port.setAdminStatus') {
      const adminUp = !/administratively down/i.test(rawOutput) && !/^\s*Down\b/im.test(rawOutput);
      return { changed: true, after: { adminUp }, note: rawOutput.slice(0, 400) };
    }
    if (action.kind === 'port.setDescription') {
      const match = rawOutput.match(/Description[:\s]+(.*)/i);
      return { changed: true, after: match?.[1]?.trim(), note: rawOutput.slice(0, 400) };
    }
    return { changed: true, after: rawOutput.slice(0, 400) };
  }
}
