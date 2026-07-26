// The contract every vendor plugs into. See signal-scope-docs/00-architecture/
// gui-cli-snmp-unification.md: the CLI is never abstracted away — adapters
// return LITERAL command lines, not a templating DSL, and are the only code
// path allowed to produce command text for a structured DeviceAction.

/** CLI mode/context — the "current position" the session-runner must track. */
export type CliMode =
  | 'exec'
  | 'privileged'
  | 'config'
  | 'config-if'
  | 'config-vlan'
  | 'operational' // Junos: no privileged/exec split
  | 'candidate';  // Junos: inside `configure`, before commit

export interface CliDialect {
  /** Regexes matching the device's prompt in each mode it can be in. Not every vendor uses every mode. */
  promptPatterns: Partial<Record<CliMode, RegExp>>;
  /** One-time paging-disable command sent right after login, or null if the platform doesn't paginate (e.g. MikroTik). */
  pagingDisableCmd: string | null;
  /** Commands to reach privileged/config-capable mode from login, or null if there's no separate enable step (e.g. Junos, MikroTik). */
  enableSequence: string[] | null;
  /** The negation particle prepended to a command to undo it ('no', 'undo'), or null where negation isn't a single particle (Junos's delete/set split, MikroTik's disable/enable verbs). */
  negationKeyword: string | null;
  /** Whether config changes are immediately live (persist-only save) or staged in a candidate buffer requiring commit. */
  saveOrCommit: {
    kind: 'persist' | 'commit' | 'none';
    commands: string[];
  };
  candidateConfig: boolean;
}

/**
 * Deliberately the same action set signal-scope-docs/comparison/
 * snmp-write-support-matrix.md already cross-references across every vendor,
 * plus two basic L3 actions for router coverage. No new scope invented here.
 */
export type DeviceAction =
  | { kind: 'port.setAdminStatus'; interfaceName: string; adminStatus: 'up' | 'down' }
  | { kind: 'port.setDescription'; interfaceName: string; description: string }
  | { kind: 'vlan.setPvid'; interfaceName: string; vlanId: number }
  | { kind: 'vlan.setTrunkAllowed'; interfaceName: string; vlanIds: number[] }
  | { kind: 'vlan.create'; vlanId: number; name: string }
  | { kind: 'config.save' }
  | { kind: 'interface.setIpAddress'; interfaceName: string; ipAddress: string; prefixLength: number }
  | { kind: 'route.static.upsert'; destinationCidr: string; nextHop: string };

export type DeviceActionKind = DeviceAction['kind'];

/** A single SNMP SET operation — the literal OID/type/value a GUI/agent action would set, echoed as `# SNMP SET <descr> = <value>` per the unification doc's rule. */
export interface SnmpSetOp {
  oid: string;
  type: 'Integer' | 'OctetString' | 'IpAddress' | 'RowStatus' | 'Unsigned32' | 'Counter64';
  value: string | number;
  /** Human-readable MIB::object form for audit/terminal display, e.g. "IF-MIB::ifAdminStatus.24". */
  description: string;
}

export interface StructuredDiff {
  changed: boolean;
  before?: unknown;
  after?: unknown;
  note?: string;
}

export interface VendorAdapter {
  readonly profileId: string;
  readonly cliDialect: CliDialect;
  /** Regex an interface name must match for this vendor — used to validate/sanitize structured-action parameters before they're ever interpolated into a command line. */
  readonly interfaceNamePattern: RegExp;

  /**
   * Literal CLI lines to send, in order, including any mode-entry/exit
   * lines (e.g. `interface GigabitEthernet0/1` before the actual command).
   * Does NOT include the enable sequence or paging-disable command (session
   * setup, handled once per dial) and does NOT include save/commit — that's
   * the separate `config.save` action, since "Save" is a structurally
   * distinct, vendor-varying concept (see gui-cli-snmp-unification.md).
   * Returns null if this vendor has no CLI path for the action at all.
   */
  buildCliPlan(action: DeviceAction): string[] | null;

  /** SNMP SET operations for this action, or null if no documented SNMP write path exists for this vendor+action (checked against device_capabilities before this is ever called — see capabilities/capability-registry.service.ts). */
  buildSnmpPlan(action: DeviceAction): SnmpSetOp[] | null;

  /** The CLI command to run immediately after applying an action, to read back and confirm the change — or null if a readback isn't meaningful for this action. */
  buildReadbackCommand(action: DeviceAction): string | null;

  /** Parses buildReadbackCommand's raw output into a structured diff. Intentionally minimal this phase — deep per-vendor `show` parsing is a documented fast-follow, not gold-plated here. */
  parseReadback(action: DeviceAction, rawOutput: string): StructuredDiff;
}
