import { VendorCliScript } from './cisco-ios.script';

/**
 * Scripted responder for exactly the command sequences
 * adapters/arista-eos.adapter.ts emits for the action set this phase tests
 * (port.setAdminStatus, port.setDescription, vlan.setPvid, config.save)
 * plus their readback commands — not a full EOS emulator, same scope as
 * cisco-ios.script.ts. See signal-scope-docs/vendors/arista/{cli-reference,
 * gui-cli-snmp-mapping}.md for the real syntax this mirrors.
 *
 * Not yet wired into cli-stub-server.ts's SCRIPTS map — a separate
 * integration step adds `'arista-eos': ARISTA_EOS_SCRIPT` there.
 */
export const ARISTA_EOS_SCRIPT: VendorCliScript = {
  initialMode: 'exec',
  initialVars: { adminUp: true, description: '', vlan: 1 },
  prompts: {
    exec: 'switch>',
    privileged: 'switch#',
    config: 'switch(config)#',
    'config-if': 'switch(config-if)#',
  },
  rules: [
    { match: 'enable', nextMode: 'privileged' },
    { match: 'terminal length 0', mode: 'privileged' },
    // EOS accepts both the short form `configure` and the IOS-familiar
    // `configure terminal` — overview.md/cli-reference.md.
    { match: 'configure terminal', mode: 'privileged', nextMode: 'config' },
    { match: 'configure', mode: 'privileged', nextMode: 'config' },
    { match: /^interface \S+$/, mode: 'config', nextMode: 'config-if' },
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
    { match: /^switchport trunk allowed vlan (.+)$/, mode: 'config-if' },
    { match: 'end', nextMode: 'privileged' },
    {
      match: 'write memory',
      mode: 'privileged',
      response: 'Copy completed successfully.',
    },
    {
      match: 'write',
      mode: 'privileged',
      response: 'Copy completed successfully.',
    },
    {
      match: 'copy running-config startup-config',
      mode: 'privileged',
      response: 'Copy completed successfully.',
    },
    {
      match: /^show interfaces Ethernet1$/,
      mode: 'privileged',
      response: (_l, v) =>
        `Ethernet1 is ${v.adminUp ? 'up' : 'administratively down'}, line protocol is ${v.adminUp ? 'up (connected)' : 'down (notconnect)'}\r\n` +
        `  Description: ${v.description || ''}\r\n` +
        `  Hardware is Ethernet, address is 001c.7300.aabb (bia 001c.7300.aabb)`,
    },
    {
      match: 'show vlan',
      mode: 'privileged',
      response: (_l, v) =>
        `VLAN  Name                             Status    Ports\r\n` +
        `----- -------------------------------- --------- -------------------------------\r\n` +
        `${v.vlan}     VLAN${v.vlan}                            active    Et1`,
    },
  ],
};
