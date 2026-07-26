export interface VendorCliRule {
  /** Restricts this rule to a single mode, or undefined to match in any mode (e.g. 'end'). */
  mode?: string;
  match: string | RegExp;
  nextMode?: string;
  response?: string | ((matchedLine: string, vars: Record<string, unknown>) => string);
  /** Records a state change (e.g. interface admin-up) so a later readback command can reflect it within the same session. */
  mutate?: (matchedLine: string, vars: Record<string, unknown>) => void;
}

export interface VendorCliScript {
  initialMode: string;
  initialVars?: Record<string, unknown>;
  prompts: Record<string, string>;
  rules: VendorCliRule[];
}

/**
 * Scripted responder for exactly the command sequences
 * adapters/cisco-ios.adapter.ts emits for the action set this phase tests
 * (port.setAdminStatus, port.setDescription, vlan.setPvid, config.save)
 * plus their readback commands — not a full IOS emulator. See
 * signal-scope-docs/vendors/cisco/{cli-reference,gui-cli-snmp-mapping}.md
 * for the real syntax this mirrors.
 */
export const CISCO_IOS_SCRIPT: VendorCliScript = {
  initialMode: 'exec',
  initialVars: { adminUp: true, description: '', vlan: 1 },
  prompts: {
    exec: 'Router>',
    privileged: 'Router#',
    config: 'Router(config)#',
    'config-if': 'Router(config-if)#',
  },
  rules: [
    { match: 'enable', nextMode: 'privileged' },
    { match: 'terminal length 0', mode: 'privileged' },
    { match: 'configure terminal', mode: 'privileged', nextMode: 'config' },
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
    { match: 'end', nextMode: 'privileged' },
    {
      match: 'copy running-config startup-config',
      mode: 'privileged',
      response: 'Destination filename [startup-config]? \r\nBuilding configuration...\r\n[OK]',
    },
    {
      match: /^show interfaces GigabitEthernet0\/1$/,
      mode: 'privileged',
      response: (_l, v) =>
        `GigabitEthernet0/1 is ${v.adminUp ? 'up' : 'administratively down'}, line protocol is ${v.adminUp ? 'up' : 'down'}\r\n` +
        `  Description: ${v.description || '(none)'}\r\n` +
        `  Hardware is Gigabit Ethernet, address is 0018.b967.3cd1 (bia 0018.b967.3cd1)`,
    },
    {
      match: 'show vlan brief',
      mode: 'privileged',
      response: (_l, v) =>
        `VLAN Name                             Status    Ports\r\n` +
        `---- -------------------------------- --------- -------------------------------\r\n` +
        `${v.vlan}    VLAN${v.vlan}                            active    Gi0/1`,
    },
  ],
};
