import { VendorCliScript } from './cisco-ios.script';

/**
 * Scripted responder for exactly the command sequences
 * adapters/extreme-exos.adapter.ts emits — not a full EXOS emulator, same
 * scope as cisco-ios.script.ts. EXOS has no persistent sub-mode, so every
 * rule below matches in the single 'exec' mode with no mode transitions.
 * See signal-scope-docs/vendors/extreme/{cli-reference,mib-reference}.md
 * for the real syntax this mirrors.
 *
 * Not yet wired into cli-stub-server.ts's SCRIPTS map — a separate
 * integration step adds `'extreme-exos': EXTREME_EXOS_SCRIPT` there.
 */
export const EXTREME_EXOS_SCRIPT: VendorCliScript = {
  initialMode: 'exec',
  initialVars: { adminUp: true, description: '', pvid: 1, trunkVlans: [] as number[], vlans: [] as { name: string; tag: number }[] },
  prompts: {
    exec: 'Switch.5 # ',
  },
  rules: [
    { match: 'disable clipaging', mode: 'exec' },
    { match: /^enable port \S+$/, mode: 'exec', mutate: (_l, v) => (v.adminUp = true) },
    { match: /^disable port \S+$/, mode: 'exec', mutate: (_l, v) => (v.adminUp = false) },
    {
      match: /^configure ports \S+ description-string "(.*)"$/,
      mode: 'exec',
      mutate: (line, v) => (v.description = line.match(/description-string "(.*)"$/)?.[1] ?? ''),
    },
    {
      match: /^configure vlan \d+ add ports \S+ untagged$/,
      mode: 'exec',
      mutate: (line, v) => (v.pvid = Number(line.match(/^configure vlan (\d+)/)?.[1] ?? v.pvid)),
    },
    {
      match: /^configure vlan \d+ add ports \S+ tagged$/,
      mode: 'exec',
      mutate: (line, v) => {
        const id = Number(line.match(/^configure vlan (\d+)/)?.[1]);
        const arr = v.trunkVlans as number[];
        if (!Number.isNaN(id) && !arr.includes(id)) arr.push(id);
      },
    },
    {
      match: /^create vlan \S+ tag \d+$/,
      mode: 'exec',
      mutate: (line, v) => {
        const name = line.match(/^create vlan (\S+)/)?.[1];
        const tag = Number(line.match(/tag (\d+)$/)?.[1]);
        if (name) (v.vlans as { name: string; tag: number }[]).push({ name, tag });
      },
    },
    {
      match: 'save configuration',
      mode: 'exec',
      response: 'Configuration saved to primary.cfg',
    },
    {
      match: /^show ports \S+ information$/,
      mode: 'exec',
      response: (line, v) => {
        const port = line.match(/^show ports (\S+) information$/)?.[1];
        return (
          `Port: ${port}\r\n` +
          `Admin State: ${v.adminUp ? 'Enabled' : 'Disabled'}\r\n` +
          `Link State: ${v.adminUp ? 'Active' : 'Ready'}\r\n` +
          `Description: ${v.description || ''}`
        );
      },
    },
    {
      match: /^show ports \S+ vlan$/,
      mode: 'exec',
      response: (_l, v) =>
        `VLAN Name        VLAN Id  Tag Status\r\n` +
        `PVID                 ${v.pvid}   Untagged\r\n` +
        `${(v.trunkVlans as number[]).map((id) => `TRUNK              ${id}   Tagged`).join('\r\n')}`,
    },
    {
      match: 'show vlan',
      mode: 'exec',
      response: (_l, v) =>
        `VLAN Name                             VLAN Id  Status    Ports\r\n` +
        `---- -------------------------------- -------- --------- -------------------------------\r\n` +
        (v.vlans as { name: string; tag: number }[]).map((vlan) => `${vlan.name}   ${vlan.tag}    active`).join('\r\n'),
    },
  ],
};
