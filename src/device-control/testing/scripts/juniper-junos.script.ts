import { VendorCliScript } from './cisco-ios.script';

/**
 * Scripted responder for exactly the command sequences
 * adapters/juniper-junos.adapter.ts emits — candidate-config/commit model,
 * `configure` never auto-exits, `run <cmd>` executes an operational
 * command without leaving config mode. See
 * signal-scope-docs/vendors/juniper/{cli-reference,gui-cli-snmp-mapping}.md
 * for the real syntax this mirrors.
 */
export const JUNIPER_JUNOS_SCRIPT: VendorCliScript = {
  initialMode: 'operational',
  initialVars: { adminUp: true, description: '', vlan: null as number | null },
  prompts: {
    operational: 'user@router>',
    candidate: 'user@router#',
  },
  rules: [
    { match: 'set cli screen-length 0', mode: 'operational' },
    { match: 'configure', mode: 'operational', nextMode: 'candidate' },
    { match: /^delete interfaces \S+ disable$/, mode: 'candidate', mutate: (_l, v) => (v.adminUp = true) },
    { match: /^set interfaces \S+ disable$/, mode: 'candidate', mutate: (_l, v) => (v.adminUp = false) },
    {
      match: /^set interfaces \S+ description "(.*)"$/,
      mode: 'candidate',
      mutate: (line, v) => (v.description = line.match(/"(.*)"/)?.[1] ?? ''),
    },
    { match: /^set interfaces \S+ unit 0 family ethernet-switching interface-mode (access|trunk)$/, mode: 'candidate' },
    {
      match: /^set interfaces \S+ unit 0 family ethernet-switching vlan members (.+)$/,
      mode: 'candidate',
      mutate: (line, v) => {
        const m = line.match(/vlan members (\d+)$/);
        if (m) v.vlan = Number(m[1]);
      },
    },
    { match: /^set vlans \S+ vlan-id \d+$/, mode: 'candidate' },
    { match: /^set interfaces \S+ unit 0 family inet address \S+$/, mode: 'candidate' },
    { match: /^set routing-options static route \S+ next-hop \S+$/, mode: 'candidate' },
    {
      // commit does NOT auto-exit configuration mode on real Junos.
      match: 'commit',
      mode: 'candidate',
      response: 'commit complete',
    },
    {
      match: /^run show interfaces \S+ terse$/,
      response: (_l, v) =>
        `Interface               Admin Link Proto    Local                 Remote\r\n` +
        `ge-0/0/1                ${v.adminUp ? 'up  ' : 'down'} ${v.adminUp ? 'up  ' : 'down'} eth-switch`,
    },
    {
      match: /^show configuration interfaces \S+$/,
      response: (_l, v) => `{\r\n    description "${v.description}";\r\n}`,
    },
    {
      match: 'run show vlans',
      response: (_l, v) => `VLAN      Tag  Interfaces\r\nstaff${v.vlan ? '     ' + v.vlan : ''}  ge-0/0/1.0`,
    },
    {
      match: 'show configuration routing-options static',
      response: 'route 0.0.0.0/0 { next-hop 10.0.0.1; }',
    },
  ],
};
