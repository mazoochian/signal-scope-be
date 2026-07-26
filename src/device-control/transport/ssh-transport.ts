import { Client, ClientChannel } from 'ssh2';
import {
  CliChannel,
  CliChannelOptions,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_PROMPT_TIMEOUT_MS,
} from './cli-channel.interface';

/**
 * SSH CLI transport — a PTY-backed shell channel via `ssh2`, per
 * signal-scope-docs/00-architecture/prior-art.md's WebSSH2 borrow: a real
 * interactive session, not exec-a-command-and-get-a-return-code.
 */
export class SshCliTransport implements CliChannel {
  private client?: Client;
  private stream?: ClientChannel;
  private buffer = '';
  private dataListeners: Array<(chunk: string) => void> = [];

  connect(opts: CliChannelOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      this.client = client;

      const timeout = setTimeout(() => {
        client.destroy();
        reject(new Error(`SSH connect to ${opts.host}:${opts.port} timed out`));
      }, opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);

      client
        .on('ready', () => {
          client.shell({ term: 'vt100', rows: 40, cols: 200 }, (err, stream) => {
            clearTimeout(timeout);
            if (err) return reject(err);
            this.stream = stream;
            stream.on('data', (data: Buffer) => this.handleData(data));
            stream.stderr.on('data', (data: Buffer) => this.handleData(data));
            resolve();
          });
        })
        .on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        })
        .connect({
          host: opts.host,
          port: opts.port,
          username: opts.username,
          password: opts.password,
          privateKey: opts.privateKey,
          readyTimeout: opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
          // Network-OS SSH daemons are frequently old and don't speak
          // modern-only algorithm sets; this list ADDS legacy algorithms
          // alongside ssh2's own modern defaults rather than replacing them
          // (an explicit `algorithms.kex` array replaces the default list
          // entirely in ssh2, so omitting a default entry here would break
          // negotiation against a modern peer — this bit us against this
          // module's own CLI stub server during testing, see
          // device-control/README.md).
          algorithms: {
            serverHostKey: ['ssh-rsa', 'rsa-sha2-256', 'rsa-sha2-512', 'ecdsa-sha2-nistp256', 'ssh-ed25519'],
          },
        });
    });
  }

  private handleData(data: Buffer) {
    const text = data.toString('utf8');
    this.buffer += text;
    for (const cb of this.dataListeners) cb(text);
  }

  sendLine(text: string): void {
    if (!this.stream) throw new Error('SSH channel not connected');
    this.stream.write(text + '\n');
  }

  waitForMatch(patterns: RegExp[], timeoutMs = DEFAULT_PROMPT_TIMEOUT_MS): Promise<{ matched: RegExp; text: string }> {
    return new Promise((resolve, reject) => {
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

      const interval = setInterval(tryMatch, 100);
      const timeout = setTimeout(() => {
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
      if (this.stream) this.stream.end();
      if (this.client) this.client.end();
      resolve();
    });
  }
}
