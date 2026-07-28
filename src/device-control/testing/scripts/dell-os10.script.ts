import { VendorCliScript } from './cisco-ios.script';

/**
 * Scripted responder for exactly the command sequences
 * adapters/dell-os10.adapter.ts emits for the action set this phase tests
 * (port.setAdminStatus, port.setDescription, vlan.setPvid, config.save)
 * plus their readback commands — not a full OS10 emulator. See
 * signal-scope-docs/vendors/dell/{cli-reference,overview}.md for the real
 * syntax this mirrors. Unlike Cisco, OS10 has no separate enable step and
 * no `end` shortcut — only single-level `exit`, so this script models one
 * extra mode transition per `exit`.
 */
export const DELL_OS10_SCRIPT: VendorCliScript = {
  initialMode: 'exec',
  initialVars: { adminUp: true, description: '', vlan: 1, currentInterface: 'ethernet 1/1/2' },
  prompts: {
    exec: 'OS10#',
    config: 'OS10(config)#',
    'config-if': 'OS10(config-if)#',
  },
  rules: [
    { match: 'configure terminal', mode: 'exec', nextMode: 'config' },
    {
      match: /^interface (.+)$/,
      mode: 'config',
      nextMode: 'config-if',
      mutate: (line, v) => (v.currentInterface = line.replace(/^interface /, '')),
    },
    { match: 'no shutdown', mode: 'config-if', mutate: (_l, v) => (v.adminUp = true) },
    { match: 'shutdown', mode: 'config-if', mutate: (_l, v) => (v.adminUp = false) },
    {
      match: /^description (.+)$/,
      mode: 'config-if',
      mutate: (line, v) => (v.description = line.replace(/^description /, '')),
    },
    {
      match: /^switchport access vlan (\d+)$/,
      mode: 'config-if',
      mutate: (line, v) => (v.vlan = Number(line.match(/(\d+)$/)?.[1] ?? v.vlan)),
    },
    { match: 'switchport mode trunk', mode: 'config-if' },
    { match: /^switchport trunk allowed vlan (.+)$/, mode: 'config-if' },
    { match: /^ip address (.+)$/, mode: 'config-if' },
    { match: /^ip route (.+)$/, mode: 'config' },
    { match: 'exit', mode: 'config-if', nextMode: 'config' },
    { match: 'exit', mode: 'config', nextMode: 'exec' },
    {
      match: 'write memory',
      mode: 'exec',
      response: 'Copying running-configuration to startup-configuration ...\r\n[OK]',
    },
    {
      match: 'show running-configuration',
      mode: 'exec',
      response: (_l, v) =>
        `interface ${v.currentInterface}\r\n` +
        `${v.description ? ` description ${v.description}\r\n` : ''}` +
        `${v.adminUp ? ' no shutdown' : ' shutdown'}\r\n` +
        `!`,
    },
  ],
};
