import { VendorCliScript } from './cisco-ios.script';

/**
 * Scripted responder for exactly the command sequences
 * adapters/dlink.adapter.ts emits (Cisco-like dialect only) — not a full
 * D-Link CLI emulator. See signal-scope-docs/vendors/dlink/overview.md.
 */
export const DLINK_SCRIPT: VendorCliScript = {
  initialMode: 'exec',
  initialVars: { adminUp: true, description: '', vlan: 1, currentIf: '1/0/5', staticRoute: '' },
  prompts: {
    exec: 'DGS-1510>',
    privileged: 'DGS-1510#',
    config: 'DGS-1510(config)#',
    'config-if': 'DGS-1510(config-if)#',
  },
  rules: [
    { match: 'enable', nextMode: 'privileged' },
    { match: 'configure terminal', mode: 'privileged', nextMode: 'config' },
    {
      match: /^interface ethernet (\S+)$/,
      mode: 'config',
      nextMode: 'config-if',
      mutate: (line, v) => (v.currentIf = line.replace(/^interface ethernet /, '')),
    },
    { match: 'no shutdown', mode: 'config-if', mutate: (_l, v) => (v.adminUp = true) },
    { match: 'shutdown', mode: 'config-if', mutate: (_l, v) => (v.adminUp = false) },
    {
      match: /^description (.+)$/,
      mode: 'config-if',
      mutate: (line, v) => (v.description = line.replace(/^description /, '')),
    },
    { match: 'switchport mode access', mode: 'config-if' },
    {
      match: /^switchport access vlan (\d+)$/,
      mode: 'config-if',
      mutate: (line, v) => (v.vlan = Number(line.match(/(\d+)$/)?.[1] ?? v.vlan)),
    },
    { match: 'switchport mode trunk', mode: 'config-if' },
    { match: /^switchport trunk allowed vlan tagged .+$/, mode: 'config-if' },
    { match: /^ip address \S+ \S+$/, mode: 'config-if' },
    { match: /^vlan \d+$/, mode: 'config', nextMode: 'config-if' },
    { match: /^name .+$/, mode: 'config-if' },
    {
      match: /^ip route \S+ \S+ \S+$/,
      mode: 'config',
      mutate: (line, v) => (v.staticRoute = line.replace(/^ip route /, '')),
    },
    { match: 'end', nextMode: 'privileged' },
    {
      match: 'copy running-config startup-config',
      mode: 'privileged',
      response: 'Destination filename startup-config? [y/n] y\r\nSaving all configurations to NV-RAM ... Done',
    },
    {
      match: /^show interfaces ethernet \S+$/,
      mode: 'privileged',
      response: (_l, v) =>
        `Ethernet${v.currentIf} is ${v.adminUp ? 'up' : 'administratively down'}, line protocol is ${v.adminUp ? 'up' : 'down'}\r\n` +
        `  Description: ${v.description || '(none)'}`,
    },
    {
      match: 'show vlan',
      mode: 'privileged',
      response: (_l, v) =>
        `VID  VLAN Name           State  Ports\r\n` +
        `---- ------------------- ------ -------\r\n` +
        `${v.vlan}    VLAN${v.vlan}              active Ethernet${v.currentIf}`,
    },
    {
      match: 'show ip route static',
      mode: 'privileged',
      response: (_l, v) => `S    ${v.staticRoute || ''} [1/0]`,
    },
  ],
};
