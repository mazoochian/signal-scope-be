import { Socket } from 'net';
import {
  CliChannel,
  CliChannelOptions,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_PROMPT_TIMEOUT_MS,
} from './cli-channel.interface';

const IAC = 0xff;
const SB = 0xfa;
const SE = 0xf0;
// WILL/WONT/DO/DONT (251-254) are each followed by exactly one option byte.
const TWO_BYTE_COMMANDS = new Set([0xfb, 0xfc, 0xfd, 0xfe]);

/**
 * Raw Telnet transport. Per signal-scope-docs/00-architecture/
 * connectivity-methods.md: "a client can often get away with disabling
 * option negotiation entirely and treating it as a dumb pipe once login
 * prompts are handled" — this strips IAC negotiation sequences out of the
 * incoming stream without ever replying to them, rather than implementing
 * full RFC 854 option negotiation. Same read-until-prompt-match interface
 * as the SSH transport, so the session-runner is transport-agnostic.
 *
 * Deliberately unencrypted — callers should flag this to the user per
 * device, per connectivity-methods.md's security note (Telnet transmits
 * credentials in the clear).
 */
export class TelnetCliTransport implements CliChannel {
  private socket?: Socket;
  private buffer = '';
  private dataListeners: Array<(chunk: string) => void> = [];
  // IAC-stripping state machine, carried across chunk boundaries.
  private inIac = false;
  private inSubneg = false;
  private pendingTwoByte = false;

  connect(opts: CliChannelOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      this.socket = socket;

      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Telnet connect to ${opts.host}:${opts.port} timed out`));
      }, opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);

      socket.once('connect', () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      socket.on('data', (data: Buffer) => this.handleData(data));

      socket.connect(opts.port, opts.host);
    });
  }

  /** Strips Telnet IAC negotiation sequences, never responds to them. */
  private stripIac(data: Buffer): string {
    const out: number[] = [];
    for (const byte of data) {
      if (this.inSubneg) {
        if (this.inIac && byte === SE) {
          this.inSubneg = false;
          this.inIac = false;
        } else {
          this.inIac = byte === IAC;
        }
        continue;
      }
      if (this.pendingTwoByte) {
        this.pendingTwoByte = false; // consume the option byte
        continue;
      }
      if (this.inIac) {
        this.inIac = false;
        if (byte === IAC) {
          out.push(IAC); // escaped literal 0xFF
        } else if (byte === SB) {
          this.inSubneg = true;
        } else if (TWO_BYTE_COMMANDS.has(byte)) {
          this.pendingTwoByte = true;
        }
        // other single-byte commands (NOP, AYT, etc.) — just consumed, no reply
        continue;
      }
      if (byte === IAC) {
        this.inIac = true;
        continue;
      }
      out.push(byte);
    }
    return Buffer.from(out).toString('utf8');
  }

  private handleData(data: Buffer) {
    const text = this.stripIac(data);
    if (!text) return;
    this.buffer += text;
    for (const cb of this.dataListeners) cb(text);
  }

  sendLine(text: string): void {
    if (!this.socket) throw new Error('Telnet socket not connected');
    this.socket.write(text + '\n');
  }

  waitForMatch(patterns: RegExp[], timeoutMs = DEFAULT_PROMPT_TIMEOUT_MS): Promise<{ matched: RegExp; text: string }> {
    return new Promise((resolve, reject) => {
      // See ssh-transport.ts's waitForMatch for why interval/timeout must
      // be declared (not just assigned) before tryMatch: the immediate
      // synchronous call below throws a TDZ ReferenceError on any prompt
      // that's already in the buffer, which the caller was silently
      // turning into `ok: false` — the same bug, same fix, copy-pasted
      // into this transport too.
      let interval: ReturnType<typeof setInterval> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const tryMatch = (): boolean => {
        for (const p of patterns) {
          if (p.test(this.buffer)) {
            clearInterval(interval);
            clearTimeout(timeout);
            const text = this.buffer;
            this.buffer = '';
            resolve({ matched: p, text });
            return true;
          }
        }
        return false;
      };

      if (tryMatch()) return;

      interval = setInterval(tryMatch, 100);
      timeout = setTimeout(() => {
        clearInterval(interval);
        reject(new Error(`Timed out waiting for prompt match. Buffer so far: ${JSON.stringify(this.buffer.slice(-300))}`));
      }, timeoutMs);
    });
  }

  async sendAndWait(text: string, patterns: RegExp[], timeoutMs = DEFAULT_PROMPT_TIMEOUT_MS): Promise<string> {
    this.sendLine(text);
    const { text: out } = await this.waitForMatch(patterns, timeoutMs);
    return out;
  }

  onData(cb: (chunk: string) => void): void {
    this.dataListeners.push(cb);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket) this.socket.end();
      resolve();
    });
  }
}
