/**
 * Vendor-flavored CLI stub server for testing ssh-transport.ts and
 * telnet-transport.ts end-to-end (real socket/PTY round trips, not
 * mocked) against a scripted responder — not a full IOS/Junos/EOS/RouterOS
 * emulator, just enough to exercise the exact command sequences the vendor
 * adapters in adapters/*.adapter.ts actually emit. See device-control/README.md
 * for why this exists instead of a pulled Docker image (no registry egress
 * in this environment).
 *
 * Runs both an SSH server (ssh2, ephemeral host key generated at startup)
 * and a raw-TCP Telnet-shaped server on two ports, sharing the same
 * scripted vendor responder so both transports get exercised.
 *
 * Run: npx ts-node src/device-control/testing/cli-stub-server.ts <vendor> [sshPort] [telnetPort]
 */
import { generateKeyPairSync } from 'crypto';
import { Server as SshServer } from 'ssh2';
import { createServer, Socket } from 'net';
import { CISCO_IOS_SCRIPT, VendorCliScript } from './scripts/cisco-ios.script';
import { JUNIPER_JUNOS_SCRIPT } from './scripts/juniper-junos.script';
import { ARISTA_EOS_SCRIPT } from './scripts/arista-eos.script';
import { MIKROTIK_ROUTEROS_SCRIPT } from './scripts/mikrotik-routeros.script';

const SCRIPTS: Record<string, VendorCliScript> = {
  'cisco-ios': CISCO_IOS_SCRIPT,
  'juniper-junos': JUNIPER_JUNOS_SCRIPT,
  'arista-eos': ARISTA_EOS_SCRIPT,
  'mikrotik-routeros': MIKROTIK_ROUTEROS_SCRIPT,
};

const vendorName = process.argv[2] ?? 'cisco-ios';
const sshPort = Number(process.argv[3] ?? 2201);
const telnetPort = Number(process.argv[4] ?? 2301);

const script = SCRIPTS[vendorName];
if (!script) {
  console.error(`Unknown vendor script "${vendorName}". Known: ${Object.keys(SCRIPTS).join(', ')}`);
  process.exit(1);
}

/** Per-connection state machine shared by both transports. `vars` is a free-form bag scripts use to remember mutated fields (e.g. an interface's admin-up state) across commands within one session, so a readback command can reflect earlier commands in the same test. */
class SessionState {
  mode: string = script.initialMode;
  lineBuffer = '';
  vars: Record<string, unknown> = { ...script.initialVars };

  handleLine(line: string): string {
    const trimmed = line.trim();
    if (trimmed.length === 0) return script.prompts[this.mode];

    for (const rule of script.rules) {
      if (rule.mode && rule.mode !== this.mode) continue;
      const match = typeof rule.match === 'string' ? trimmed === rule.match : rule.match.test(trimmed);
      if (!match) continue;
      rule.mutate?.(trimmed, this.vars);
      if (rule.nextMode) this.mode = rule.nextMode;
      const response = typeof rule.response === 'function' ? rule.response(trimmed, this.vars) : rule.response;
      return `${response ? response + '\r\n' : ''}${script.prompts[this.mode]}`;
    }

    return `% Unrecognized command in stub: ${trimmed}\r\n${script.prompts[this.mode]}`;
  }
}

function feedByte(state: SessionState, chunk: string, write: (text: string) => void) {
  for (const ch of chunk) {
    if (ch === '\r' || ch === '\n') {
      if (state.lineBuffer.length === 0) continue;
      const out = state.handleLine(state.lineBuffer);
      state.lineBuffer = '';
      write(out);
    } else {
      state.lineBuffer += ch;
    }
  }
}

// ── SSH server ────────────────────────────────────────────────────────────
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const sshServer = new SshServer({ hostKeys: [privateKey] }, (client) => {
  client
    .on('authentication', (ctx) => ctx.accept())
    .on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        const state = new SessionState();
        session.on('pty', (accept: () => void) => accept?.());
        session.on('shell', (accept: () => import('ssh2').ServerChannel) => {
          const stream = accept();
          stream.write(script.prompts[state.mode]);
          stream.on('data', (data: Buffer) => feedByte(state, data.toString('utf8'), (text) => stream.write(text)));
        });
      });
    })
    .on('error', () => {});
});
sshServer.listen(sshPort, '127.0.0.1', () => {
  console.log(`[cli-stub] SSH (${vendorName}) listening on 127.0.0.1:${sshPort}`);
});

// ── Telnet-shaped raw TCP server (no IAC negotiation, dumb pipe — matches the client transport's own philosophy) ──
const telnetServer = createServer((socket: Socket) => {
  const state = new SessionState();
  socket.write(script.prompts[state.mode]);
  socket.on('data', (data: Buffer) => feedByte(state, data.toString('utf8'), (text) => socket.write(text)));
});
telnetServer.listen(telnetPort, '127.0.0.1', () => {
  console.log(`[cli-stub] Telnet (${vendorName}) listening on 127.0.0.1:${telnetPort}`);
});
