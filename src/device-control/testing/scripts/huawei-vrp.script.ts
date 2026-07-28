import { VendorCliScript } from './cisco-ios.script';

/**
 * Scripted responder for exactly the command sequences
 * adapters/huawei-vrp.adapter.ts emits for the action set this phase tests
 * (port.setAdminStatus, port.setDescription, vlan.setPvid, config.save)
 * plus their readback commands — not a full VRP emulator. See
 * signal-scope-docs/vendors/huawei/{cli-reference,gui-cli-snmp-mapping}.md
 * for the real syntax this mirrors. Modes: exec (user view, `<Huawei>`),
 * config (system-view, `[Huawei]`), config-if (interface view,
 * `[Huawei-GigabitEthernet0/0/1]`), config-vlan (VLAN view, `[Huawei-vlan10]`).
 * `quit` is mode-scoped (unlike Cisco's single `end`) since VRP only moves
 * up one level per `quit` — interface/VLAN view -> system-view -> user view.
 */
export const HUAWEI_VRP_SCRIPT: VendorCliScript = {
  initialMode: 'exec',
  initialVars: { adminUp: true, description: '', vlan: 1 },
  prompts: {
    exec: '<Huawei>',
    config: '[Huawei]',
    'config-if': '[Huawei-GigabitEthernet0/0/1]',
    'config-vlan': '[Huawei-vlan10]',
  },
  rules: [
    { match: 'screen-length 0 temporary', mode: 'exec' },
    { match: 'system-view', mode: 'exec', nextMode: 'config' },
    { match: /^interface \S+$/, mode: 'config', nextMode: 'config-if' },
    { match: 'undo shutdown', mode: 'config-if', mutate: (_l, v) => (v.adminUp = true) },
    { match: 'shutdown', mode: 'config-if', mutate: (_l, v) => (v.adminUp = false) },
    {
      match: /^description (.+)$/,
      mode: 'config-if',
      mutate: (line, v) => (v.description = line.replace(/^description /, '')),
    },
    { match: 'port link-type access', mode: 'config-if' },
    { match: 'port link-type trunk', mode: 'config-if' },
    { match: /^port default vlan (\d+)$/, mode: 'config-if', mutate: (line, v) => (v.vlan = Number(line.match(/(\d+)$/)?.[1] ?? v.vlan)) },
    { match: /^port trunk allow-pass vlan .+$/, mode: 'config-if' },
    { match: /^vlan (\d+)$/, mode: 'config', nextMode: 'config-vlan', mutate: (line, v) => (v.vlan = Number(line.match(/(\d+)$/)?.[1] ?? v.vlan)) },
    {
      match: /^description (.+)$/,
      mode: 'config-vlan',
      mutate: (line, v) => (v.description = line.replace(/^description /, '')),
    },
    { match: 'quit', mode: 'config-if', nextMode: 'config' },
    { match: 'quit', mode: 'config-vlan', nextMode: 'config' },
    { match: 'quit', mode: 'config', nextMode: 'exec' },
    {
      match: 'save',
      mode: 'exec',
      response: 'Warning: The current configuration will be written to the device.\r\nAre you sure to continue?[Y/N]y\r\nInfo: Save the configuration successfully.',
    },
    {
      match: /^display interface GigabitEthernet0\/0\/1$/,
      response: (_l, v) =>
        `GigabitEthernet0/0/1 current state : ${v.adminUp ? 'UP' : 'Administratively DOWN'}\r\n` +
        `Line protocol current state : ${v.adminUp ? 'UP' : 'DOWN'}\r\n` +
        `Description : ${v.description || ''}`,
    },
    {
      match: /^display vlan(?: \d+)?$/,
      response: (_l, v) =>
        `VLAN ID  Type    Status  Property  MAC-LRN  Statistics  Description\r\n` +
        `-------  ------  ------  --------  -------  ----------  -----------\r\n` +
        `${v.vlan}     common  enable  default   enable   disable     ${v.description || `VLAN0${v.vlan}`.slice(0, 6)}`,
    },
    {
      match: 'display ip routing-table',
      response: 'Route Flags: R - relay, D - download to fib\r\n------------------------------------------------------------------------------\r\nRouting Tables: Public',
    },
  ],
};
