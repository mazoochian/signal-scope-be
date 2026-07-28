import {
  CliDialect,
  DeviceAction,
  SnmpSetOp,
  StructuredDiff,
  VendorAdapter,
} from './vendor-adapter.interface';

/**
 * Huawei VRP (S-series switches) — transcribed from signal-scope-docs/
 * vendors/huawei/{overview,cli-reference,mib-reference,gui-cli-snmp-mapping}.md.
 * Structurally similar to Cisco IOS (immediate-apply, hierarchical modal
 * CLI) but with real dialect differences this adapter models directly
 * rather than reusing Cisco's shape: `system-view` replaces the
 * enable+configure-terminal split (VRP has no separate privileged-EXEC
 * step by default), `undo` replaces `no`, `quit` replaces `end` (and only
 * moves up ONE level — VRP has no single "jump to top" verb short of
 * `return`, which this adapter doesn't use since every plan here is only
 * ever one level deep), and read-back is `display` instead of `show`.
 *
 * SNMP write surface is this project's weakest-evidenced after Dell's
 * verified-absence finding: only `Q-BRIDGE-MIB::dot1qPvid` (access-VLAN
 * assignment) is confirmed writable, directly from Huawei's own MIB
 * reference page ("only dot1qPvid can be modified" in that table). Trunk
 * allow-list, VLAN creation, STP edge-port, LACP membership, port-security,
 * and config-save are all explicitly flagged "not independently confirmed"
 * in gui-cli-snmp-mapping.md — this adapter returns `null` for every one of
 * those rather than guessing. Standard IF-MIB objects (admin-status,
 * description) are treated as real per mib-reference.md's "Supported"
 * baseline determination, same tier the other adapters give IF-MIB.
 */
export class HuaweiVrpAdapter implements VendorAdapter {
  readonly profileId = 'huawei-vrp';
  // <Type><stack/chassis>/<slot>/<port>, e.g. GigabitEthernet0/0/1 —
  // three-part, NOT Cisco's two-part 0/1 — cli-reference.md.
  readonly interfaceNamePattern = /^[A-Za-z-]+[0-9]+\/[0-9]+\/[0-9]+$/;

  readonly cliDialect: CliDialect = {
    promptPatterns: {
      exec: /^<\S+>\s*$/, // user view, e.g. <Huawei>
      config: /^\[\S+\]\s*$/, // system-view, e.g. [Huawei]
      'config-if': /^\[\S+-\S+\]\s*$/, // interface view, e.g. [Huawei-GigabitEthernet0/0/1]
      'config-vlan': /^\[\S+-vlan\d+\]\s*$/, // VLAN view, e.g. [Huawei-vlan10]
    },
    pagingDisableCmd: 'screen-length 0 temporary', // session-scoped, not persisted — overview.md
    enableSequence: null, // no separate unprivileged/privileged EXEC split by default
    negationKeyword: 'undo',
    saveOrCommit: { kind: 'persist', commands: ['save'] },
    candidateConfig: false,
  };

  buildCliPlan(action: DeviceAction): string[] | null {
    switch (action.kind) {
      case 'port.setAdminStatus':
        return [
          'system-view',
          `interface ${action.interfaceName}`,
          action.adminStatus === 'up' ? 'undo shutdown' : 'shutdown',
          'quit',
        ];

      case 'port.setDescription':
        return [
          'system-view',
          `interface ${action.interfaceName}`,
          `description ${action.description}`,
          'quit',
        ];

      case 'vlan.setPvid':
        // cli-reference.md: access mode must be set (or already in effect)
        // before `port default vlan`.
        return [
          'system-view',
          `interface ${action.interfaceName}`,
          'port link-type access',
          `port default vlan ${action.vlanId}`,
          'quit',
        ];

      case 'vlan.setTrunkAllowed':
        // cli-reference.md's own example shows a contiguous range
        // ("vlan 10 to 20"); an arbitrary, possibly-non-contiguous id list
        // isn't literally illustrated for allow-pass specifically, but
        // `vlan batch`'s documented "individual IDs and to-ranges can be
        // mixed" list grammar is the same space-separated convention VRP
        // uses throughout — applying it here rather than inventing a
        // different separator.
        return [
          'system-view',
          `interface ${action.interfaceName}`,
          'port link-type trunk',
          `port trunk allow-pass vlan ${action.vlanIds.join(' ')}`,
          'quit',
        ];

      case 'vlan.create':
        // overview.md names `description` as an example VLAN-view
        // subcommand (alongside port-membership shortcuts) but no worked
        // example is given in cli-reference.md the way interface/VLAN
        // membership commands are — flagged at the same "plausible,
        // not fully spelled out" confidence tier the Juniper/Aruba
        // adapters use for their own extrapolated syntax.
        return ['system-view', `vlan ${action.vlanId}`, `description ${action.name}`, 'quit'];

      case 'config.save':
        // Run from user/system view, not inside an interface/VLAN
        // context — matches gui-cli-snmp-mapping.md's "save is always a
        // separate, explicit step" note. The real device prompts an
        // interactive Y/N (and optionally a filename); this adapter
        // returns only the literal command line per every other adapter's
        // convention of not modeling interactive prompts.
        return [this.cliDialect.saveOrCommit.commands[0]];

      case 'interface.setIpAddress':
        // Not documented in this docs tree (Huawei docs here cover L2
        // switch config only) — standard VRP `ip address` convention,
        // same out-of-docs confidence tier Juniper/Arista/Aruba/Dell used
        // for their own L3 actions.
        return [
          'system-view',
          `interface ${action.interfaceName}`,
          `ip address ${action.ipAddress} ${prefixToNetmask(action.prefixLength)}`,
          'quit',
        ];

      case 'route.static.upsert':
        // Same out-of-docs confidence tier as interface.setIpAddress above.
        return [
          'system-view',
          `ip route-static ${cidrToNetworkAndMask(action.destinationCidr)} ${action.nextHop}`,
        ];

      default:
        return null;
    }
  }

  buildSnmpPlan(action: DeviceAction): SnmpSetOp[] | null {
    switch (action.kind) {
      case 'port.setAdminStatus':
        // IF-MIB is a "Supported" baseline per mib-reference.md, same
        // confidence tier the other adapters give this standard object.
        return [
          {
            oid: '1.3.6.1.2.1.2.2.1.7.<ifIndex>',
            type: 'Integer',
            value: action.adminStatus === 'up' ? 1 : 2,
            description: `IF-MIB::ifAdminStatus.<ifIndex> = ${action.adminStatus === 'up' ? 'up(1)' : 'down(2)'}`,
          },
        ];

      case 'port.setDescription':
        return [
          {
            oid: '1.3.6.1.2.1.31.1.1.1.18.<ifIndex>',
            type: 'OctetString',
            value: action.description,
            description: `IF-MIB::ifAlias.<ifIndex> = "${action.description}"`,
          },
        ];

      case 'vlan.setPvid':
        // mib-reference.md: Huawei's own Q-BRIDGE-MIB reference page states
        // "only dot1qPvid can be modified" in the port-VLAN table — the one
        // genuinely confirmed SNMP-write path on this vendor.
        return [
          {
            oid: '1.3.6.1.2.1.17.7.1.4.5.1.1.<bridgePort>', // Q-BRIDGE-MIB::dot1qPvid.<bridge-port>
            type: 'Integer',
            value: action.vlanId,
            description: `Q-BRIDGE-MIB::dot1qPvid.<bridgePort> = ${action.vlanId}`,
          },
        ];

      // Trunk allow-list, VLAN creation, STP edge-port, LACP membership,
      // port-security, and config-save: gui-cli-snmp-mapping.md explicitly
      // flags every one of these as "not independently confirmed" — CLI-
      // only, correctly returning null rather than guessing at OIDs.
      default:
        return null;
    }
  }

  buildReadbackCommand(action: DeviceAction): string | null {
    switch (action.kind) {
      case 'port.setAdminStatus':
      case 'port.setDescription':
      case 'interface.setIpAddress':
        return `display interface ${action.interfaceName}`;
      case 'vlan.setPvid':
        return `display vlan ${action.vlanId}`;
      case 'vlan.setTrunkAllowed':
        return `display interface ${action.interfaceName}`;
      case 'vlan.create':
        return 'display vlan';
      case 'route.static.upsert':
        // Not literally documented in this docs tree — standard VRP
        // convention, same out-of-docs confidence tier as the CLI plan
        // above.
        return 'display ip routing-table';
      case 'config.save':
        return null;
      default:
        return null;
    }
  }

  parseReadback(action: DeviceAction, rawOutput: string): StructuredDiff {
    // Intentionally minimal, matching the other adapters' level of effort
    // this phase — enough to confirm the round trip, not a full `display`
    // output parser.
    if (action.kind === 'port.setAdminStatus') {
      const adminUp = /current state\s*:\s*UP/i.test(rawOutput) && !/administratively down/i.test(rawOutput);
      const operUp = /Line protocol current state\s*:\s*UP/i.test(rawOutput);
      return { changed: true, after: { adminUp, operUp }, note: rawOutput.slice(0, 400) };
    }
    if (action.kind === 'port.setDescription') {
      const match = rawOutput.match(/Description\s*:\s*(.*)/i);
      return { changed: true, after: match?.[1]?.trim(), note: rawOutput.slice(0, 400) };
    }
    return { changed: true, after: rawOutput.slice(0, 400) };
  }
}

function prefixToNetmask(prefixLength: number): string {
  const bits = 0xffffffff << (32 - prefixLength);
  return [24, 16, 8, 0].map((shift) => ((bits >>> shift) & 0xff)).join('.');
}

function cidrToNetworkAndMask(cidr: string): string {
  const [network, prefixStr] = cidr.split('/');
  return `${network} ${prefixToNetmask(Number(prefixStr))}`;
}
