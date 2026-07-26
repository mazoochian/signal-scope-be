import {
  CliDialect,
  DeviceAction,
  SnmpSetOp,
  StructuredDiff,
  VendorAdapter,
} from './vendor-adapter.interface';

/**
 * Cisco IOS/IOS-XE — the reference vendor adapter implementation. Every
 * command line and OID below is transcribed directly from
 * signal-scope-docs/vendors/cisco/{gui-cli-snmp-mapping,mib-reference,
 * cli-reference}.md — this is not new research, it's the existing docs
 * tree's literal command tables in adapter shape. Later vendor adapters
 * (Juniper, Arista, MikroTik) follow this file's structure.
 */
export class CiscoIosAdapter implements VendorAdapter {
  readonly profileId = 'cisco-ios';
  // <Type><slot>/<port>, e.g. GigabitEthernet0/1 — cli-syntax-matrix.md
  readonly interfaceNamePattern = /^[A-Za-z]+[0-9]+(\/[0-9]+)*$/;

  readonly cliDialect: CliDialect = {
    promptPatterns: {
      exec: /\S+>\s*$/,
      privileged: /\S+#\s*$/,
      config: /\S+\(config\)#\s*$/,
      'config-if': /\S+\(config-if\)#\s*$/,
    },
    pagingDisableCmd: 'terminal length 0',
    enableSequence: ['enable'],
    negationKeyword: 'no',
    saveOrCommit: { kind: 'persist', commands: ['copy running-config startup-config'] },
    candidateConfig: false,
  };

  buildCliPlan(action: DeviceAction): string[] | null {
    switch (action.kind) {
      case 'port.setAdminStatus':
        return [
          'configure terminal',
          `interface ${action.interfaceName}`,
          action.adminStatus === 'up' ? 'no shutdown' : 'shutdown',
          'end',
        ];

      case 'port.setDescription':
        return [
          'configure terminal',
          `interface ${action.interfaceName}`,
          `description ${action.description}`,
          'end',
        ];

      case 'vlan.setPvid':
        // gui-cli-snmp-mapping.md: switchport mode access is required first
        // if the port isn't already in access mode — the caller/GUI should
        // check current mode via read-back before deciding whether to
        // include it; this adapter always includes it since re-issuing it
        // on an already-access port is a harmless no-op on IOS.
        return [
          'configure terminal',
          `interface ${action.interfaceName}`,
          'switchport mode access',
          `switchport access vlan ${action.vlanId}`,
          'end',
        ];

      case 'vlan.setTrunkAllowed':
        return [
          'configure terminal',
          `interface ${action.interfaceName}`,
          'switchport mode trunk',
          `switchport trunk allowed vlan ${action.vlanIds.join(',')}`,
          'end',
        ];

      case 'vlan.create':
        return ['configure terminal', `vlan ${action.vlanId}`, `name ${action.name}`, 'end'];

      case 'config.save':
        return [this.cliDialect.saveOrCommit.commands[0]];

      case 'interface.setIpAddress':
        return [
          'configure terminal',
          `interface ${action.interfaceName}`,
          `ip address ${action.ipAddress} ${prefixToNetmask(action.prefixLength)}`,
          'end',
        ];

      case 'route.static.upsert':
        return [
          'configure terminal',
          `ip route ${cidrToNetworkAndMask(action.destinationCidr)} ${action.nextHop}`,
          'end',
        ];

      default:
        return null;
    }
  }

  buildSnmpPlan(action: DeviceAction): SnmpSetOp[] | null {
    switch (action.kind) {
      case 'port.setAdminStatus':
        // ifIndex must be resolved by the caller (a prior SNMP GET/walk of
        // ifName->ifIndex) — the adapter's buildSnmpPlan is pure and has no
        // ifIndex parameter in the DeviceAction; the processor resolves it
        // and substitutes into the oid template below before sending.
        // net-snmp needs numeric OIDs for the actual GET/SET wire call — it
        // doesn't resolve symbolic MIB::object names unless a MIB module
        // store is loaded (see standard-mibs.md for the numeric indices:
        // ifTable/ifAdminStatus = 1.3.6.1.2.1.2.2.1.7). `description` keeps
        // the human-readable MIB::object form for the audit log/terminal
        // echo, per the "# SNMP SET <descr>" convention.
        return [
          {
            oid: '1.3.6.1.2.1.2.2.1.7.<ifIndex>', // ifTable::ifAdminStatus.<ifIndex>
            type: 'Integer',
            value: action.adminStatus === 'up' ? 1 : 2,
            description: `IF-MIB::ifAdminStatus.<ifIndex> = ${action.adminStatus === 'up' ? 'up(1)' : 'down(2)'}`,
          },
        ];

      case 'port.setDescription':
        return [
          {
            oid: '1.3.6.1.2.1.31.1.1.1.18.<ifIndex>', // ifXTable::ifAlias.<ifIndex>
            type: 'OctetString',
            value: action.description,
            description: `IF-MIB::ifAlias.<ifIndex> = "${action.description}"`,
          },
        ];

      case 'vlan.setPvid':
        // mib-reference.md: CISCO-VLAN-MEMBERSHIP-MIB::vmVlan is Cisco's
        // own documented SNMP path for access-VLAN assignment.
        return [
          {
            oid: '1.3.6.1.4.1.9.9.68.1.2.2.1.2.<ifIndex>', // vmVlan.<ifIndex>
            type: 'Integer',
            value: action.vlanId,
            description: `CISCO-VLAN-MEMBERSHIP-MIB::vmVlan.<ifIndex> = ${action.vlanId}`,
          },
        ];

      case 'config.save':
        // CISCO-CONFIG-COPY-MIB::ccCopyTable row creation — documented
        // end-to-end by Cisco. A full implementation needs a RowStatus
        // create-poll-complete sequence (see mib-reference.md); this
        // returns the row-creation SET, the processor polls ccCopyState
        // separately per standard-mibs.md's RowStatus pattern note.
        return [
          { oid: '1.3.6.1.4.1.9.9.96.1.1.1.1.3.1', type: 'Integer', value: 4, description: 'ccCopySourceFileType.1 = runningConfig(4)' },
          { oid: '1.3.6.1.4.1.9.9.96.1.1.1.1.4.1', type: 'Integer', value: 3, description: 'ccCopyDestFileType.1 = startupConfig(3)' },
          { oid: '1.3.6.1.4.1.9.9.96.1.1.1.1.14.1', type: 'RowStatus', value: 4, description: 'ccCopyEntryRowStatus.1 = createAndGo(4)' },
        ];

      // Trunk allowed-VLAN, STP edge-port, LACP membership, port-security,
      // SNMP self-config: no documented SNMP write path on Cisco per
      // comparison/snmp-write-support-matrix.md and mib-reference.md's
      // explicitly-flagged cases — CLI-only, correctly returning null.
      default:
        return null;
    }
  }

  buildReadbackCommand(action: DeviceAction): string | null {
    switch (action.kind) {
      case 'port.setAdminStatus':
      case 'port.setDescription':
        return `show interfaces ${action.interfaceName}`;
      case 'vlan.setPvid':
        return 'show vlan brief';
      case 'vlan.setTrunkAllowed':
        return 'show interfaces trunk';
      case 'vlan.create':
        return 'show vlan brief';
      case 'interface.setIpAddress':
        return `show interfaces ${action.interfaceName}`;
      case 'route.static.upsert':
        return 'show ip route static';
      case 'config.save':
        return null;
      default:
        return null;
    }
  }

  parseReadback(action: DeviceAction, rawOutput: string): StructuredDiff {
    // Intentionally minimal this phase — deep per-vendor `show` output
    // parsing is a documented fast-follow (see device-control/README.md),
    // not gold-plated here. Covers the two cases the simulator test
    // exercises end-to-end; everything else returns the raw text
    // unparsed rather than guessing at a shape.
    if (action.kind === 'port.setAdminStatus') {
      const isUp = /line protocol is up/i.test(rawOutput) || /,\s*line protocol is up/i.test(rawOutput);
      const adminUp = /GigabitEthernet\S*\s+is up/i.test(rawOutput) || /is administratively up/i.test(rawOutput) || !/administratively down/i.test(rawOutput);
      return { changed: true, after: { adminUp, operUp: isUp }, note: rawOutput.slice(0, 400) };
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
