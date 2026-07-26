import {
  CliDialect,
  DeviceAction,
  SnmpSetOp,
  StructuredDiff,
  VendorAdapter,
} from './vendor-adapter.interface';

/**
 * Fallback adapter for any device without a specific vendor adapter yet
 * (i.e. all 9 vendors documented in signal-scope-docs but not implemented
 * this phase — Extreme, Huawei, Aruba, Dell, D-Link, Fortinet, Ubiquiti,
 * Netgear, Zyxel). No vendor CLI knowledge at all — only the standard
 * IF-MIB objects that are read-write per the base IETF MIB on every
 * vendor's implementation (see standard-mibs.md), offered at 'assumed'
 * confidence, never 'confirmed', since per-vendor honoring of the SET
 * varies (see comparison/snmp-write-support-matrix.md's repeated finding
 * that MAX-ACCESS read-write in MIB source is not the same as a supported
 * SET workflow).
 */
export class GenericSnmpAdapter implements VendorAdapter {
  readonly profileId = 'generic-snmp';
  readonly interfaceNamePattern = /^.+$/; // no vendor-specific naming convention known
  readonly cliDialect: CliDialect = {
    promptPatterns: {},
    pagingDisableCmd: null,
    enableSequence: null,
    negationKeyword: null,
    saveOrCommit: { kind: 'none', commands: [] },
    candidateConfig: false,
  };

  buildCliPlan(): string[] | null {
    return null; // no vendor CLI knowledge
  }

  buildSnmpPlan(action: DeviceAction): SnmpSetOp[] | null {
    switch (action.kind) {
      case 'port.setAdminStatus':
        return null; // ifIndex resolution requires a prior GET; the caller resolves this, not the adapter — see device-action.processor.ts
      case 'port.setDescription':
        return null;
      default:
        return null;
    }
  }

  buildReadbackCommand(): string | null {
    return null;
  }

  parseReadback(_action: DeviceAction, rawOutput: string): StructuredDiff {
    return { changed: false, note: 'generic-snmp adapter has no readback parsing', after: rawOutput };
  }
}
