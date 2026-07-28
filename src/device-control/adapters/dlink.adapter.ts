import {
  CliDialect,
  DeviceAction,
  SnmpSetOp,
  StructuredDiff,
  VendorAdapter,
} from './vendor-adapter.interface';

/**
 * D-Link — models ONLY the newer "Cisco-like" CLI family (DGS-1210/ME,
 * DGS-1510, DGS-3130, DGS-3620, DGS-6600), per
 * signal-scope-docs/vendors/dlink/overview.md's two-dialect split. D-Link's
 * OTHER family — the classic xStack/native CLI (DGS-3000/3400/3600/3100,
 * DES-3xxx: flat verb-first commands like `config ports <list> state
 * enable`, `create vlan <name> tag <id>`, no persistent interface context)
 * — is deliberately NOT implemented by this adapter. A device speaking the
 * xStack dialect needs its own adapter (or a dialect-detection layer keyed
 * off sysDescr/sysObjectID, per the docs' own recommendation) before
 * SignalScope can drive it; this profile would silently emit wrong syntax
 * against it.
 *
 * Appendix-tier doc — several command lines below are flagged inferred
 * (not literally present in overview.md) where the "Cisco-like" family
 * characterization makes the Cisco-shaped command a reasonable, low-risk
 * guess (e.g. `description`, `ip address`, `ip route`, `vlan <id>`/`name`);
 * these are marked per-case. SNMP write support is explicitly NOT
 * independently confirmed for either D-Link dialect (overview.md: "treat
 * D-Link SNMP as primarily a read/monitoring surface... pending
 * device-specific confirmation") — buildSnmpPlan is therefore null
 * throughout, same discipline as Arista's/Juniper's unconfirmed rows.
 */
export class DlinkAdapter implements VendorAdapter {
  readonly profileId = 'dlink';
  // <unit>/<module>/<port>, e.g. 1/0/5 — overview.md's "interface range ethernet 1/0/5-1/0/16" example
  readonly interfaceNamePattern = /^[0-9]+\/[0-9]+\/[0-9]+$/;

  readonly cliDialect: CliDialect = {
    promptPatterns: {
      exec: /\S+>\s*$/,
      privileged: /\S+#\s*$/,
      config: /\S+\(config\)#\s*$/,
      'config-if': /\S+\(config-if\)#\s*$/,
    },
    // Not documented for D-Link's Cisco-like family in overview.md (unlike
    // Cisco's own confirmed `terminal length 0`) — conservatively null
    // rather than guessed.
    pagingDisableCmd: null,
    // Inferred from the "Cisco-like" characterization, not separately
    // confirmed in overview.md the way `shutdown`/`no shutdown` is.
    enableSequence: ['enable'],
    negationKeyword: 'no', // confirmed: overview.md shows `shutdown` / `no shutdown` directly
    saveOrCommit: { kind: 'persist', commands: ['copy running-config startup-config'] }, // confirmed
    candidateConfig: false,
  };

  buildCliPlan(action: DeviceAction): string[] | null {
    switch (action.kind) {
      case 'port.setAdminStatus':
        // Confirmed shape (overview.md curated CLI table); singular
        // `interface ethernet <port>` (vs. the doc's `interface range
        // ethernet <start>-<end>`) is the inferred single-port form.
        return [
          'configure terminal',
          `interface ethernet ${action.interfaceName}`,
          action.adminStatus === 'up' ? 'no shutdown' : 'shutdown',
          'end',
        ];

      case 'port.setDescription':
        // Inferred — not in overview.md's curated table, but a standard
        // Cisco-like-family interface command.
        return [
          'configure terminal',
          `interface ethernet ${action.interfaceName}`,
          `description ${action.description}`,
          'end',
        ];

      case 'vlan.setPvid':
        // Confirmed: overview.md's curated CLI table, "VLAN tagged/untagged
        // port membership" row, Cisco-like column.
        return [
          'configure terminal',
          `interface ethernet ${action.interfaceName}`,
          'switchport mode access',
          `switchport access vlan ${action.vlanId}`,
          'end',
        ];

      case 'vlan.setTrunkAllowed':
        // Confirmed, with the D-Link-specific `tagged` keyword the docs
        // call out as distinct from Cisco's plain `switchport trunk
        // allowed vlan <list>`.
        return [
          'configure terminal',
          `interface ethernet ${action.interfaceName}`,
          'switchport mode trunk',
          `switchport trunk allowed vlan tagged ${action.vlanIds.join(',')}`,
          'end',
        ];

      case 'vlan.create':
        // Inferred — overview.md only shows `create vlan <name> tag <id>`
        // for the classic xStack dialect; Cisco-like `vlan <id>` / `name
        // <name>` is the reasonable Cisco-parity guess for this family.
        return ['configure terminal', `vlan ${action.vlanId}`, `name ${action.name}`, 'end'];

      case 'config.save':
        return [this.cliDialect.saveOrCommit.commands[0]];

      case 'interface.setIpAddress':
        // Inferred — not in overview.md at all; standard Cisco-like syntax.
        return [
          'configure terminal',
          `interface ethernet ${action.interfaceName}`,
          `ip address ${action.ipAddress} ${prefixToNetmask(action.prefixLength)}`,
          'end',
        ];

      case 'route.static.upsert':
        // Inferred — not in overview.md at all; standard Cisco-like syntax.
        return [
          'configure terminal',
          `ip route ${cidrToNetworkAndMask(action.destinationCidr)} ${action.nextHop}`,
          'end',
        ];

      default:
        return null;
    }
  }

  buildSnmpPlan(_action: DeviceAction): SnmpSetOp[] | null {
    // overview.md is explicit: "not independently confirmed this session
    // beyond the standard cross-vendor baseline... treat D-Link SNMP as
    // primarily a read/monitoring surface... pending device-specific
    // confirmation of any broader SNMP SET support." No action in this
    // phase's DeviceAction set gets a real SNMP plan for D-Link.
    return null;
  }

  buildReadbackCommand(action: DeviceAction): string | null {
    // overview.md's GUI/CLI/SNMP mapping table only shows classic-dialect
    // readback commands (`show ports 1:1`, `show vlan Sales`) — the
    // Cisco-like equivalents below are inferred by analogy to Cisco's own
    // `show interfaces`/`show vlan brief`/`show ip route static`.
    switch (action.kind) {
      case 'port.setAdminStatus':
      case 'port.setDescription':
      case 'interface.setIpAddress':
        return `show interfaces ethernet ${action.interfaceName}`;
      case 'vlan.setPvid':
      case 'vlan.setTrunkAllowed':
      case 'vlan.create':
        return 'show vlan';
      case 'route.static.upsert':
        return 'show ip route static';
      case 'config.save':
        return null;
      default:
        return null;
    }
  }

  parseReadback(action: DeviceAction, rawOutput: string): StructuredDiff {
    // Intentionally minimal this phase, matching cisco-ios.adapter.ts's
    // level of effort.
    if (action.kind === 'port.setAdminStatus') {
      const adminUp = !/administratively down/i.test(rawOutput);
      const operUp = /line protocol is up/i.test(rawOutput);
      return { changed: true, after: { adminUp, operUp }, note: rawOutput.slice(0, 400) };
    }
    if (action.kind === 'port.setDescription') {
      const match = rawOutput.match(/Description:\s*(.*)/i);
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
