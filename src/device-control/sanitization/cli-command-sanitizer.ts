/**
 * Two distinct sanitization paths (see device-control/README.md for the
 * full rationale):
 *
 * 1. Structured actions (DeviceAction): sanitized by construction — a
 *    vendor adapter's buildCliPlan/buildSnmpPlan only ever interpolates
 *    already-validated typed parameters into fixed templates it owns. The
 *    validators below (validateInterfaceName, validateVlanId, ...) are what
 *    "already-validated" means in practice, and DTOs call them via
 *    class-validator custom decorators before an action ever reaches an
 *    adapter.
 * 2. Raw CLI passthrough (a human's literal typed command, forwarded
 *    as-is): sanitizeRawCliLine() below is the gate every such line must
 *    pass before it is ever written to a transport channel.
 *
 * Invariant this module exists to make true: no device-bound command line
 * is ever built by string-concatenating unvalidated user input, and no
 * device-bound command line is ever passed through a local shell
 * (child_process exec/spawn with shell:true) anywhere in this codebase —
 * these lines are written directly to an SSH/Telnet channel's own stream,
 * which the remote device's CLI interprets, not this process's shell.
 */

const MAX_RAW_LINE_LENGTH = 500;

// Generous allowlist for network-OS CLI argument syntax (hostnames,
// interface names, VLAN lists, quoted descriptions, IP/CIDR, pipe filters)
// while still explicitly excluding shell metacharacters as defense in
// depth, even though nothing in this module ever reaches a local shell.
// Excluded: backtick, $, ;, &, |  is *allowed* narrowly below since some
// vendor CLIs use it for `show ... | include ...` — see PIPE_ALLOWED note.
const ALLOWED_CHARS = /^[\x20-\x7e]*$/; // printable ASCII only, no control chars

const SHELL_METACHARACTERS = /[`$;&\\]/; // backtick, $, ;, &, backslash — never legitimate in a network-OS CLI argument in this project's vendor set

/** Denylisted destructive command patterns, checked case-insensitively against the full line. Curated from the vendor docs tree's own vocabulary, not exhaustive — a defense-in-depth layer, not the only gate (RBAC's device-control-raw:manage permission is the primary gate for bypassing this). */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\breload\b/i,
  /\brestart\b/i,
  /\berase\s+startup-config\b/i,
  /\bwrite\s+erase\b/i,
  /\bformat\b/i,
  /\bfactory[-\s]?(reset|default)\b/i,
  /\bdelete\s+.*\.(bin|img|npk)\b/i, // firmware image deletion
  /\bno\s+boot\s+system\b/i,
  /\/system\s+reset-configuration\b/i, // MikroTik
  /\bsystem\s+shutdown\b/i,
  /\brequest\s+system\s+(reboot|halt|zeroize)\b/i, // Junos
];

export interface SanitizeResult {
  ok: boolean;
  reason?: string;
  /** Set when ok is true — the exact bytes to send, after control-char stripping. */
  line?: string;
  /** Set when ok is true — whether this line matched the destructive denylist and needs the elevated device-control-raw:manage permission to proceed. */
  isDestructive?: boolean;
}

export function sanitizeRawCliLine(input: string): SanitizeResult {
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, reason: 'Empty command' };
  }
  if (input.length > MAX_RAW_LINE_LENGTH) {
    return { ok: false, reason: `Command exceeds ${MAX_RAW_LINE_LENGTH} characters` };
  }
  // Reject anything with embedded CR/LF/control chars (a single logical
  // command per call — no smuggling a second command via a hidden newline)
  // or non-printable-ASCII bytes (rules out raw Telnet IAC bytes and ANSI
  // escape sequences at the source, before they'd ever reach a transport).
  if (!ALLOWED_CHARS.test(input)) {
    return { ok: false, reason: 'Command contains control characters or non-ASCII bytes' };
  }
  if (SHELL_METACHARACTERS.test(input)) {
    return { ok: false, reason: 'Command contains disallowed characters (`, $, ;, &, \\)' };
  }

  const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(input));
  return { ok: true, line: input, isDestructive };
}

/** Per-session raw-command rate limiter — a simple fixed-window counter, one instance per open session. */
export class RawCommandRateLimiter {
  private count = 0;
  private windowStart = Date.now();

  constructor(
    private readonly maxPerWindow = 30,
    private readonly windowMs = 60_000,
  ) {}

  tryConsume(): boolean {
    const now = Date.now();
    if (now - this.windowStart > this.windowMs) {
      this.windowStart = now;
      this.count = 0;
    }
    if (this.count >= this.maxPerWindow) return false;
    this.count++;
    return true;
  }
}

export function validateInterfaceName(name: string, pattern: RegExp): boolean {
  return typeof name === 'string' && name.length > 0 && name.length <= 64 && pattern.test(name);
}

export function validateVlanId(vlanId: number): boolean {
  return Number.isInteger(vlanId) && vlanId >= 1 && vlanId <= 4094;
}

export function validateDescription(description: string): boolean {
  // Descriptions are free text but still go through a device CLI argument —
  // same printable-ASCII + no-shell-metacharacter rule as raw lines.
  return (
    typeof description === 'string' &&
    description.length <= 200 &&
    ALLOWED_CHARS.test(description) &&
    !SHELL_METACHARACTERS.test(description)
  );
}
