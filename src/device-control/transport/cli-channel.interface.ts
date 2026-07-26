/**
 * Shared shape for an interactive CLI transport (SSH or Telnet). Network-OS
 * CLIs are stateful REPLs, not exec-and-get-exit-code — this is a PTY-backed
 * (or PTY-equivalent) channel that reads until a prompt regex matches, the
 * same primitive Netmiko/Ansible's network_cli use (see
 * signal-scope-docs/00-architecture/prior-art.md). The session-runner
 * (queue/device-action.processor.ts) is transport-agnostic against this
 * interface — it doesn't know or care whether it's talking SSH or Telnet.
 */
export interface CliChannelOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** SSH only. */
  privateKey?: string;
  connectTimeoutMs?: number;
}

export interface CliChannel {
  connect(opts: CliChannelOptions): Promise<void>;
  /** Writes text + newline to the channel without waiting for a response. */
  sendLine(text: string): void;
  /** Buffers output until a line matches one of `patterns`, or times out. */
  waitForMatch(patterns: RegExp[], timeoutMs?: number): Promise<{ matched: RegExp; text: string }>;
  /** sendLine + waitForMatch in one call — the common case. */
  sendAndWait(text: string, patterns: RegExp[], timeoutMs?: number): Promise<string>;
  /** Taps the raw output stream — used by the audit log and, later, a live-terminal WS gateway. */
  onData(cb: (chunk: string) => void): void;
  close(): Promise<void>;
}

export const DEFAULT_PROMPT_TIMEOUT_MS = 8000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 8000;
