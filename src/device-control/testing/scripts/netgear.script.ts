import { VendorCliRule, VendorCliScript } from './cisco-ios.script';

/**
 * Scripted responder for the command sequences adapters/netgear.adapter.ts
 * emits (port.setAdminStatus, port.setDescription, config.save, plus their
 * readback commands) — not a full M-series CLI emulator. See
 * signal-scope-docs/vendors/netgear/overview.md for the real syntax this
 * mirrors (assumed-by-convention IOS-adjacent shape, save command confirmed).
 */
const rules: VendorCliRule[] = [
  { match: 'enable', nextMode: 'privileged' },
  { match: 'configure', mode: 'privileged', nextMode: 'config' },
  { match: /^interface \S+$/, mode: 'config', nextMode: 'config-if' },
  { match: 'no shutdown', mode: 'config-if', mutate: (_l, v) => (v.adminUp = true) },
  { match: 'shutdown', mode: 'config-if', mutate: (_l, v) => (v.adminUp = false) },
  {
    match: /^description (.+)$/,
    mode: 'config-if',
    mutate: (line, v) => (v.description = line.replace(/^description /, '')),
  },
  { match: 'exit', mode: 'config-if', nextMode: 'config' },
  { match: 'exit', mode: 'config', nextMode: 'privileged' },
  {
    match: 'copy system:running-config nvram:startup-config',
    mode: 'privileged',
    response: 'Configuration Saved!',
  },
  {
    match: /^show interface 1\/0\/1$/,
    mode: 'privileged',
    response: (_l, v) =>
      `Interface 1/0/1\r\n` +
      `Port Status: ${v.adminUp ? 'Up' : 'Down'}\r\n` +
      `Admin Mode: ${v.adminUp ? 'Enable' : 'Disable'}\r\n` +
      `Description: ${v.description || ''}`,
  },
];

export const NETGEAR_SCRIPT: VendorCliScript = {
  initialMode: 'exec',
  initialVars: { adminUp: true, description: '' },
  prompts: {
    exec: 'Netgear>',
    privileged: 'Netgear#',
    config: 'Netgear(config)#',
    'config-if': 'Netgear(config-if)#',
  },
  rules,
};
