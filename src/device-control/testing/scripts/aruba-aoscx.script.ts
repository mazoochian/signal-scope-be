import { VendorCliScript } from './cisco-ios.script';

/**
 * Scripted responder for exactly the command sequences
 * adapters/aruba-aoscx.adapter.ts emits (port.setAdminStatus,
 * port.setDescription, vlan.setPvid, config.save) plus their readback
 * commands — not a full AOS-CX emulator. See
 * signal-scope-docs/vendors/aruba/{cli-reference,gui-cli-snmp-mapping}.md
 * for the real syntax this mirrors.
 */
export const ARUBA_AOSCX_SCRIPT: VendorCliScript = {
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
    { match: 'no page', mode: 'privileged' },
    { match: 'configure terminal', mode: 'privileged', nextMode: 'config' },
    { match: /^interface \S+$/, mode: 'config', nextMode: 'config-if' },
    { match: 'no shutdown', mode: 'config-if', mutate: (_l, v) => (v.adminUp = true) },
    { match: 'shutdown', mode: 'config-if', mutate: (_l, v) => (v.adminUp = false) },
    {
      match: /^description (.+)$/,
      mode: 'config-if',
      mutate: (line, v) => (v.description = line.replace(/^description /, '')),
    },
    {
      match: /^vlan access (\d+)$/,
      mode: 'config-if',
      mutate: (line, v) => (v.vlan = Number(line.match(/(\d+)$/)?.[1] ?? v.vlan)),
    },
    { match: 'end', nextMode: 'privileged' },
    {
      match: 'copy running-config startup-config',
      mode: 'privileged',
      response: 'Copying configuration... \r\nSaving Configuration... \r\n[OK]',
    },
    {
      match: /^show interface 1\/1\/1$/,
      mode: 'privileged',
      response: (_l, v) =>
        `1/1/1 is ${v.adminUp ? 'up' : 'administratively down'}, line protocol is ${v.adminUp ? 'up' : 'down'}\r\n` +
        `  Description: ${v.description || '(none)'}\r\n` +
        `  Hardware is Ethernet, address is 08:00:09:aa:bb:01`,
    },
    {
      match: 'show vlan',
      mode: 'privileged',
      response: (_l, v) =>
        `VLAN  Name                             Status    Ports\r\n` +
        `----- -------------------------------- --------- -------------------------------\r\n` +
        `${v.vlan}     VLAN${v.vlan}                            up        1/1/1`,
    },
  ],
};
