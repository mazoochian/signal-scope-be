import { VendorCliScript } from './cisco-ios.script';

/**
 * Scripted responder for the small, genuinely-confirmed slice of Zyxel
 * standalone-managed-line syntax that zyxel.adapter.ts emits
 * (`configure` -> `vlan <n>`, `write memory`) plus the `show
 * running-config` readback command. Deliberately minimal — this vendor's
 * adapter itself only covers two confirmed write actions, so there's
 * little to script. See signal-scope-docs/vendors/zyxel/overview.md.
 */
export const ZYXEL_SCRIPT: VendorCliScript = {
  initialMode: 'exec',
  initialVars: { vlans: [] as number[] },
  prompts: {
    exec: 'Switch>',
    config: 'Switch(config)#',
  },
  rules: [
    { match: 'configure', mode: 'exec', nextMode: 'config' },
    {
      match: /^vlan (\d+)$/,
      mode: 'config',
      mutate: (line, v) => {
        const vlans = (v.vlans as number[]) ?? [];
        const id = Number(line.match(/(\d+)$/)?.[1]);
        if (!vlans.includes(id)) vlans.push(id);
        v.vlans = vlans;
      },
    },
    {
      match: 'write memory',
      mode: 'exec',
      response: 'Write to FLASH Done.',
    },
    {
      match: 'write memory',
      mode: 'config',
      response: 'Write to FLASH Done.',
    },
    {
      match: 'show running-config',
      mode: 'exec',
      response: (_l, v) => {
        const vlans = (v.vlans as number[]) ?? [];
        return ['vlan database', ...vlans.map((id) => `vlan ${id}`), 'exit'].join('\r\n');
      },
    },
  ],
};
