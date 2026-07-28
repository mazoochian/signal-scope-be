import { VendorCliScript } from './cisco-ios.script';

/**
 * Scripted responder for exactly the command sequences
 * adapters/ubiquiti.adapter.ts emits (port.setAdminStatus, vlan.setPvid,
 * vlan.setTrunkAllowed) plus their shared `show running-config` readback —
 * not a full EdgeSwitch/FASTPATH emulator, and deliberately does NOT model
 * the real SSH→Linux-shell→telnet-localhost hop (the stub server IS the
 * "already reached the switch CLI" endpoint) — only the `telnet 127.0.0.1`
 * / `enable` lines the adapter's cliDialect.enableSequence sends are
 * modeled as mode transitions. See
 * signal-scope-docs/vendors/ubiquiti/overview.md.
 */
export const UBIQUITI_SCRIPT: VendorCliScript = {
  initialMode: 'exec',
  initialVars: { adminUp: true, pvid: 1, tagged: [] as number[] },
  prompts: {
    exec: 'Switch>',
    privileged: 'Switch#',
    config: 'Switch(config)#',
    'config-if': 'Switch(config-if)#',
  },
  rules: [
    { match: 'telnet 127.0.0.1', mode: 'exec' },
    { match: 'enable', nextMode: 'privileged' },
    { match: 'configure', mode: 'privileged', nextMode: 'config' },
    { match: /^interface \S+$/, mode: 'config', nextMode: 'config-if' },
    { match: 'no shutdown', mode: 'config-if', mutate: (_l, v) => (v.adminUp = true) },
    { match: 'shutdown', mode: 'config-if', mutate: (_l, v) => (v.adminUp = false) },
    { match: /^vlan participation include ([\d,]+)$/, mode: 'config-if' },
    {
      match: /^vlan pvid (\d+)$/,
      mode: 'config-if',
      mutate: (line, v) => (v.pvid = Number(line.match(/(\d+)$/)?.[1] ?? v.pvid)),
    },
    {
      match: /^vlan tagging ([\d,]+)$/,
      mode: 'config-if',
      mutate: (line, v) => (v.tagged = (line.match(/([\d,]+)$/)?.[1] ?? '').split(',').filter(Boolean).map(Number)),
    },
    { match: 'exit', mode: 'config-if', nextMode: 'config' },
    {
      match: /^show running-config$/,
      mode: 'privileged',
      response: (_l, v) =>
        `interface 0/1\r\n` +
        ` vlan participation include ${v.pvid}\r\n` +
        ` vlan pvid ${v.pvid}\r\n` +
        (Array.isArray(v.tagged) && v.tagged.length > 0 ? ` vlan tagging ${(v.tagged as number[]).join(',')}\r\n` : '') +
        (v.adminUp ? '' : ` shutdown\r\n`),
    },
  ],
};
