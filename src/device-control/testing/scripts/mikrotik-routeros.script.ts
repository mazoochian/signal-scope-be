import { VendorCliRule, VendorCliScript } from './cisco-ios.script';

/**
 * Scripted responder for exactly the command sequences
 * adapters/mikrotik-routeros.adapter.ts emits for the action set this phase
 * tests (port.setAdminStatus, port.setDescription, vlan.setPvid) plus their
 * readback commands — not a full RouterOS emulator. See
 * signal-scope-docs/vendors/mikrotik/{cli-reference,overview}.md for the
 * real syntax this mirrors.
 *
 * Unlike CISCO_IOS_SCRIPT, RouterOS barely has "modes" at all — there is no
 * EXEC/config split and no per-command context to enter/exit (see
 * mikrotik-routeros.adapter.ts's top-of-file comment). Every rule below
 * omits `mode`, matching VendorCliRule's documented "undefined matches in
 * any mode" behavior, and `initialMode` never changes for the lifetime of a
 * session — there is exactly one mode, kept only because VendorCliScript's
 * shape requires naming one.
 */
const rules: VendorCliRule[] = [
  // Port admin state — cli-reference.md "Interface admin state and
  // description" table: single self-contained line, immediate effect, no
  // shutdown/no-shutdown verb pair.
  {
    match: /^\/interface disable (\S+)$/,
    mutate: (_l, v) => (v.adminUp = false),
  },
  {
    match: /^\/interface enable (\S+)$/,
    mutate: (_l, v) => (v.adminUp = true),
  },
  // Port comment/description.
  {
    match: /^\/interface set (\S+) comment="(.*)"$/,
    mutate: (line, v) => {
      const m = line.match(/comment="(.*)"$/);
      v.comment = m?.[1] ?? '';
    },
  },
  // Access-port PVID via the bridge-VLAN-filtering model.
  {
    match: /^\/interface bridge port set \[find interface=(\S+)\] pvid=(\d+)$/,
    mutate: (line, v) => {
      const m = line.match(/pvid=(\d+)$/);
      v.pvid = Number(m?.[1] ?? v.pvid);
    },
  },
  // Readback: /interface print detail where name=ether1 — cli-reference.md
  // "Read-back / print commands" table. Response shape mirrors real
  // RouterOS `/interface print detail` output closely enough for
  // mikrotik-routeros.adapter.ts's parseReadback() to exercise its
  // disabled=/comment= regex matches.
  {
    match: /^\/interface print detail where name=(\S+)$/,
    response: (line, v) => {
      const name = line.match(/name=(\S+)$/)?.[1] ?? 'ether1';
      const flag = v.adminUp ? 'R' : 'X';
      return ` 0  ${flag} name="${name}" default-name="${name}" type="ether" mtu=1500 l2mtu=1598 disabled=${v.adminUp ? 'no' : 'yes'} running=${v.adminUp ? 'yes' : 'no'} comment="${v.comment ?? ''}"`;
    },
  },
  // Readback: /interface bridge port print detail where interface=ether2 —
  // reflects the pvid mutated above.
  {
    match: /^\/interface bridge port print detail where interface=(\S+)$/,
    response: (line, v) => {
      const name = line.match(/interface=(\S+)$/)?.[1] ?? 'ether2';
      return ` 0    interface=${name} bridge=bridge1 pvid=${v.pvid ?? 1} frame-types=admit-all horizon=none`;
    },
  },
];

export const MIKROTIK_ROUTEROS_SCRIPT: VendorCliScript = {
  initialMode: 'exec',
  initialVars: { adminUp: true, comment: '', pvid: 1 },
  prompts: {
    // overview.md's example prompt shape: `[admin@MikroTik] >` at the menu
    // root. This stub never actually `cd`s into a menu level (every rule
    // above matches a fully-qualified path), so the prompt never needs to
    // reflect a sub-menu suffix like `[admin@MikroTik] /interface bridge>`.
    exec: '[admin@MikroTik] > ',
  },
  rules,
};
