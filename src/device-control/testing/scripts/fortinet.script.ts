import { VendorCliRule, VendorCliScript } from './cisco-ios.script';

/**
 * Scripted responder for exactly the command sequences
 * adapters/fortinet.adapter.ts emits for the action set this phase tests
 * (port.setAdminStatus, port.setDescription, vlan.setPvid,
 * vlan.setTrunkAllowed) plus their readback commands — not a full
 * FortiSwitchOS emulator. See signal-scope-docs/vendors/fortinet/
 * overview.md for the real grammar this mirrors.
 *
 * Modeled with the fixed CliMode set the module's session-state tracker
 * uses: 'exec' for the FortiOS root prompt (`#`), 'config' for inside
 * `config switch interface` (`(interface) #`), 'config-if' for inside
 * `edit "port5"` (`("port5") #`) — FortiOS's real prompt nests the current
 * context name, reflected in the mode-specific prompt strings below rather
 * than a fixed per-mode string, since this stub only ever exercises port5.
 */
const rules: VendorCliRule[] = [
  { match: 'config switch interface', mode: 'exec', nextMode: 'config' },
  { match: /^edit "?\S+"?$/, mode: 'config', nextMode: 'config-if' },
  { match: /^set status (up|down)$/, mode: 'config-if', mutate: (line, v) => (v.adminUp = /up$/.test(line)) },
  {
    match: /^set description "(.*)"$/,
    mode: 'config-if',
    mutate: (line, v) => (v.description = line.match(/^set description "(.*)"$/)?.[1] ?? ''),
  },
  { match: /^set native-vlan (\d+)$/, mode: 'config-if', mutate: (line, v) => (v.pvid = Number(line.match(/(\d+)$/)?.[1] ?? v.pvid)) },
  {
    match: /^set allowed-vlans (.+)$/,
    mode: 'config-if',
    mutate: (line, v) => (v.allowedVlans = line.replace(/^set allowed-vlans /, '')),
  },
  { match: 'next', mode: 'config-if', nextMode: 'config' },
  { match: 'end', mode: 'config', nextMode: 'exec' },
  {
    match: /^get switch physical-port \S+$/,
    mode: 'exec',
    response: (_l, v) => `name: port5\r\nstatus: ${v.adminUp ? 'up' : 'down'}\r\ndescription: "${v.description || ''}"`,
  },
  {
    match: 'get switch vlan',
    mode: 'exec',
    response: (_l, v) => `interface: port5\r\nnative-vlan: ${v.pvid}\r\nallowed-vlans: ${v.allowedVlans || ''}`,
  },
];

export const FORTINET_SCRIPT: VendorCliScript = {
  initialMode: 'exec',
  initialVars: { adminUp: true, description: '', pvid: 1, allowedVlans: '' },
  prompts: {
    exec: 'FortiSwitch #',
    config: 'FortiSwitch (interface) #',
    'config-if': 'FortiSwitch ("port5") #',
  },
  rules,
};
