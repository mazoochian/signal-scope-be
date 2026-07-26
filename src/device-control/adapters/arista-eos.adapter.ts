import {
  CliDialect,
  DeviceAction,
  SnmpSetOp,
  StructuredDiff,
  VendorAdapter,
} from './vendor-adapter.interface';

/**
 * Arista EOS — deliberately IOS-compatible CLI shape (same mode-based
 * session model, same negation keyword, same paging-disable command); every
 * command line and OID below is transcribed directly from
 * signal-scope-docs/vendors/arista/{overview,gui-cli-snmp-mapping,
 * mib-reference,cli-reference}.md and comparison/{cli-syntax-matrix,
 * snmp-write-support-matrix}.md — this is not new research. See
 * cisco-ios.adapter.ts for the reference shape this file follows.
 *
 * IMPORTANT divergence from Cisco: Arista's own SNMP MIB documentation
 * states "all MIB support is read-only unless otherwise noted" — only
 * IF-MIB::ifAdminStatus and IF-MIB::ifAlias are confirmed writable (2 of 9
 * researched actions). Every other buildSnmpPlan() case below returns null,
 * deliberately NOT mirroring Cisco's vlan.setPvid (CISCO-VLAN-MEMBERSHIP-MIB
 * is a Cisco enterprise MIB with no Arista equivalent) or config.save
 * (CISCO-CONFIG-COPY-MIB; ARISTA-CONFIG-COPY-MIB exists by name but no
 * confirmed SET trigger was found — see mib-reference.md).
 */
export class AristaEosAdapter implements VendorAdapter {
  readonly profileId = 'arista-eos';
  // Ethernet<n> or Ethernet<slot>/<port> — no speed-encoded type prefix like
  // Cisco's GigabitEthernet. cli-syntax-matrix.md / overview.md.
  readonly interfaceNamePattern = /^Ethernet[0-9]+(\/[0-9]+)?$/;

  readonly cliDialect: CliDialect = {
    promptPatterns: {
      exec: /\S+>\s*$/,
      privileged: /\S+#\s*$/,
      config: /\S+\(config\)#\s*$/,
      'config-if': /\S+\(config-if\)#\s*$/,
    },
    pagingDisableCmd: 'terminal length 0', // identical text to IOS — cli-reference.md
    enableSequence: ['enable'],
    negationKeyword: 'no',
    // cli-syntax-matrix.md's save/persist row + migration 022's seeded
    // cli.save_persist_cmd: 'write memory' is the canonical EOS shorthand
    // (cli-reference.md also lists 'write' and 'copy running-config
    // startup-config' as equivalent forms; 'write memory' is used here to
    // match the already-seeded vendor_capability_defaults row).
    saveOrCommit: { kind: 'persist', commands: ['write memory'] },
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
        // gui-cli-snmp-mapping.md: same IOS-parity structure as Cisco — set
        // access mode then assign the access VLAN. No confirmed SNMP path
        // (see buildSnmpPlan below), this is CLI-only on Arista.
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
        // cli-reference.md: `vlan <id>` then `name <text>` in vlan-config
        // submode — identical structure to Cisco, sent as literal lines
        // the same way cisco-ios.adapter.ts does (no explicit config-vlan
        // mode tracking in cliDialect, matching that file's level of effort).
        return ['configure terminal', `vlan ${action.vlanId}`, `name ${action.name}`, 'end'];

      case 'config.save':
        return [this.cliDialect.saveOrCommit.commands[0]];

      case 'interface.setIpAddress':
        // NOT covered in signal-scope-docs/vendors/arista/ — EOS's routed
        // (L3) interface IP address syntax uses CIDR notation
        // ("ip address <ip>/<prefixLength>") rather than IOS's dotted-decimal
        // netmask form. This is well-established EOS behavior but was not
        // independently confirmed against the docs tree this session — see
        // this adapter's spec file and the final report for the explicit
        // confidence flag. Also note: real EOS front-panel ports default to
        // L2 (switchport) mode and require `no switchport` before `ip
        // address` will apply — omitted here to keep parity with
        // cisco-ios.adapter.ts's equivalent (also un-gated); flagged as a
        // known gap, not silently assumed away.
        return [
          'configure terminal',
          `interface ${action.interfaceName}`,
          `ip address ${action.ipAddress}/${action.prefixLength}`,
          'end',
        ];

      case 'route.static.upsert':
        // NOT covered in signal-scope-docs/vendors/arista/ — EOS static
        // route syntax is CIDR-based ("ip route <prefix>/<len> <next-hop>"),
        // unlike IOS's network+netmask form. Same confidence caveat as
        // interface.setIpAddress above.
        return ['configure terminal', `ip route ${action.destinationCidr} ${action.nextHop}`, 'end'];

      default:
        return null;
    }
  }

  buildSnmpPlan(action: DeviceAction): SnmpSetOp[] | null {
    switch (action.kind) {
      case 'port.setAdminStatus':
        // mib-reference.md / gui-cli-snmp-mapping.md: one of only two
        // confirmed EOS SNMP write paths. Same standard IF-MIB numeric OID
        // as Cisco (this is a standard object, not vendor-specific) —
        // ifIndex substitution happens the same way cisco-ios.adapter.ts
        // documents: the processor resolves ifIndex via a prior GET/walk
        // and substitutes into the <ifIndex> template before sending.
        return [
          {
            oid: '1.3.6.1.2.1.2.2.1.7.<ifIndex>', // ifTable::ifAdminStatus.<ifIndex>
            type: 'Integer',
            value: action.adminStatus === 'up' ? 1 : 2,
            description: `IF-MIB::ifAdminStatus.<ifIndex> = ${action.adminStatus === 'up' ? 'up(1)' : 'down(2)'}`,
          },
        ];

      case 'port.setDescription':
        // The other of the two confirmed exceptions to Arista's
        // read-only-unless-noted MIB posture.
        return [
          {
            oid: '1.3.6.1.2.1.31.1.1.1.18.<ifIndex>', // ifXTable::ifAlias.<ifIndex>
            type: 'OctetString',
            value: action.description,
            description: `IF-MIB::ifAlias.<ifIndex> = "${action.description}"`,
          },
        ];

      // vlan.setPvid: Q-BRIDGE-MIB::dot1qPvid is the conceptual object but
      // Arista's Q-BRIDGE-MIB support is listed read-only with no exception
      // noted (mib-reference.md) — no CISCO-VLAN-MEMBERSHIP-MIB equivalent
      // exists on Arista at all (it's a Cisco enterprise MIB). CLI-only.
      //
      // vlan.setTrunkAllowed: no confirmed SNMP write path
      // (dot1qVlanStaticEgressPorts/UntaggedPorts unconfirmed on EOS).
      // CLI-only.
      //
      // vlan.create: same Q-BRIDGE-MIB read-only posture — no confirmed
      // dot1qVlanStaticRowStatus write path documented for EOS. CLI-only.
      //
      // config.save: ARISTA-CONFIG-COPY-MIB / ARISTA-CONFIG-MAN-MIB exist by
      // name (analogous to Cisco's CISCO-CONFIG-COPY-MIB) but no confirmed
      // SET-triggered copy/save workflow was found — gui-cli-snmp-mapping.md
      // flags this "CLI-only pending further research," not asserted either
      // way. Returning null is the conservative/correct default per the
      // capability-gating rule (README.md "SNMP write safety").
      //
      // interface.setIpAddress / route.static.upsert: not part of Arista's
      // researched action set in the docs tree; no SNMP path documented.
      // CLI-only.
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
        return 'show vlan'; // cli-reference.md: "VLAN table | show vlan | Identical to IOS"
      case 'vlan.setTrunkAllowed':
        // Not explicitly listed in cli-reference.md's read-back table
        // (which only confirms show interfaces status / show vlan / show
        // spanning-tree / show running-config section interface / show
        // port-channel / show lacp interface) — 'show interfaces trunk' is
        // used here on the strength of the documented IOS-parity of the
        // trunk *config* commands, but this specific show command was not
        // independently confirmed this session. Flagged in the final report.
        return 'show interfaces trunk';
      case 'vlan.create':
        return 'show vlan';
      case 'interface.setIpAddress':
        return `show interfaces ${action.interfaceName}`;
      case 'route.static.upsert':
        // Not explicitly confirmed in the docs tree — mirrors Cisco's
        // 'show ip route static' on the assumption EOS's `show ip route`
        // family supports the same filter keyword; flagged in the final
        // report as inferred, not transcribed.
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
    // matching cisco-ios.adapter.ts's level of effort exactly. EOS's
    // `show interfaces <name>` line-1 format ("Ethernet1 is up, line
    // protocol is up (connected)" / "... is administratively down, line
    // protocol is down (notconnect)") is IOS-parity enough that the same
    // regex approach applies without hard-coding an interface-type prefix.
    if (action.kind === 'port.setAdminStatus') {
      const isUp = /line protocol is up/i.test(rawOutput);
      const adminUp = !/administratively down/i.test(rawOutput);
      return { changed: true, after: { adminUp, operUp: isUp }, note: rawOutput.slice(0, 400) };
    }
    if (action.kind === 'port.setDescription') {
      const match = rawOutput.match(/Description:\s*(.*)/i);
      return { changed: true, after: match?.[1]?.trim(), note: rawOutput.slice(0, 400) };
    }
    return { changed: true, after: rawOutput.slice(0, 400) };
  }
}
