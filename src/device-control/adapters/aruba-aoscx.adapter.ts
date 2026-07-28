import {
  CliDialect,
  DeviceAction,
  SnmpSetOp,
  StructuredDiff,
  VendorAdapter,
} from './vendor-adapter.interface';

/**
 * HPE Aruba Networking — ArubaOS-CX (6xxx/8xxx series). Scope is
 * ArubaOS-CX only — the legacy ArubaOS-Switch/ProCurve and Comware-based
 * HPE dialects are explicitly out of scope, per
 * signal-scope-docs/vendors/aruba/overview.md, and are not implemented by
 * this adapter. Every command line and OID below is transcribed directly
 * from signal-scope-docs/vendors/aruba/{overview,cli-reference,
 * mib-reference,gui-cli-snmp-mapping}.md.
 *
 * By a clear margin, this is the richest `buildSnmpPlan` of any vendor in
 * this project: AOS-CX has confirmed SNMP-write coverage for VLAN
 * (creation, PVID, and — uniquely among every vendor here — trunk
 * allowed-list/tagged membership too) via the standard `Q-BRIDGE-MIB`, and
 * config persistence via the vendor's own RowStatus-driven
 * `ARUBAWIRED-CONFIG-MIB`. AOS-CX also has confirmed SNMP write surface
 * for STP port-hardening (edge-port/PortFast-equivalent, BPDU Guard,
 * Root Guard, Loop Guard via `ARUBAWIRED-MSTP-MIB`) and port security
 * (`ARUBAWIRED-PORTSECURITY-MIB`) — but neither concept has a
 * corresponding `DeviceAction` kind in this phase's action set (see
 * vendor-adapter.interface.ts), so those findings can't be represented
 * here; they're not invented as new action kinds.
 */
export class ArubaAosCxAdapter implements VendorAdapter {
  readonly profileId = 'aruba-aoscx';
  // <member>/<slot>/<port>, e.g. 1/1/1 — cli-reference.md
  readonly interfaceNamePattern = /^\d+\/\d+\/\d+$/;

  readonly cliDialect: CliDialect = {
    promptPatterns: {
      exec: /\S+>\s*$/,
      privileged: /\S+#\s*$/,
      config: /\S+\(config\)#\s*$/,
      'config-if': /\S+\(config-if\)#\s*$/,
    },
    // cli-reference.md "Paging control": `no page` — confirmed session-only
    // (not persistent beyond the session, per the Phase 2 reversal of the
    // earlier community-sourced "persists across reboot" claim).
    pagingDisableCmd: 'no page',
    enableSequence: ['enable'],
    negationKeyword: 'no',
    // cli-reference.md: `copy running-config startup-config` (aliased
    // `write memory`) — persist-only, IOS-identical. AOS-CX additionally
    // layers an opt-in `checkpoint`/`checkpoint auto <n>` guarded-apply
    // safety net on top (see overview.md's config-apply model section),
    // but that's a distinct, separate GUI concept from plain Save per the
    // docs' own recommendation — not modeled as this adapter's default
    // save path.
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
        // cli-reference.md: `vlan access <n>` sets access mode AND PVID in
        // ONE command — unlike Cisco's two-step `switchport mode access` +
        // `switchport access vlan <n>`.
        return [
          'configure terminal',
          `interface ${action.interfaceName}`,
          `vlan access ${action.vlanId}`,
          'end',
        ];

      case 'vlan.setTrunkAllowed':
        // cli-reference.md: `vlan trunk allowed <VLAN-LIST>` (search-summary
        // sourced, official CLI-bank page 403'd this session) — the docs
        // don't separately document a trunk-mode-entry command distinct
        // from this one, unlike Cisco's `switchport mode trunk`.
        return [
          'configure terminal',
          `interface ${action.interfaceName}`,
          `vlan trunk allowed ${action.vlanIds.join(',')}`,
          'end',
        ];

      case 'vlan.create':
        return ['configure terminal', `vlan ${action.vlanId}`, `name ${action.name}`, 'end'];

      case 'config.save':
        return [this.cliDialect.saveOrCommit.commands[0]];

      case 'interface.setIpAddress':
        // AOS-CX uses CIDR-form `ip address <ip>/<prefix>` (not a separate
        // netmask, unlike Cisco) — standard AOS-CX L3 convention, not
        // literally spelled out in cli-reference.md (that file's interface
        // section only covers admin-state/description/speed), same
        // out-of-docs confidence caveat used by the Juniper/Arista/MikroTik
        // adapters for their own L3 actions.
        return [
          'configure terminal',
          `interface ${action.interfaceName}`,
          `ip address ${action.ipAddress}/${action.prefixLength}`,
          'end',
        ];

      case 'route.static.upsert':
        // Same out-of-docs confidence caveat as interface.setIpAddress above.
        return ['configure terminal', `ip route ${action.destinationCidr} ${action.nextHop}`, 'end'];

      default:
        return null;
    }
  }

  buildSnmpPlan(action: DeviceAction): SnmpSetOp[] | null {
    switch (action.kind) {
      case 'port.setAdminStatus':
        // Standard baseline object, confirmed reliable per
        // gui-cli-snmp-mapping.md's "Enable/Disable port" rows.
        return [
          {
            oid: '1.3.6.1.2.1.2.2.1.7.<ifIndex>', // IF-MIB::ifAdminStatus.<ifIndex>
            type: 'Integer',
            value: action.adminStatus === 'up' ? 1 : 2,
            description: `IF-MIB::ifAdminStatus.<ifIndex> = ${action.adminStatus === 'up' ? 'up(1)' : 'down(2)'}`,
          },
        ];

      case 'port.setDescription':
        return [
          {
            oid: '1.3.6.1.2.1.31.1.1.1.18.<ifIndex>', // IF-MIB::ifAlias.<ifIndex>
            type: 'OctetString',
            value: action.description,
            description: `IF-MIB::ifAlias.<ifIndex> = "${action.description}"`,
          },
        ];

      case 'vlan.setPvid':
        // mib-reference.md: standard Q-BRIDGE-MIB::dot1qPvid (in
        // dot1qPortVlanTable) is AOS-CX's real SNMP write path for
        // access-VLAN/PVID — the vendor-native ARUBAWIRED-PORTVLAN-MIB
        // equivalent is confirmed READ-ONLY, this is the correct object.
        // OID computed from the vendored RFC 4363 text: qBridgeMIB
        // (dot1dBridge.7) -> qBridgeMIBObjects.4 (dot1qVlan) ->
        // dot1qPortVlanTable(5) -> Entry(1) -> dot1qPvid(1).
        return [
          {
            oid: '1.3.6.1.2.1.17.7.1.4.5.1.1.<ifIndex>', // Q-BRIDGE-MIB::dot1qPvid.<ifIndex>
            type: 'Integer',
            value: action.vlanId,
            description: `Q-BRIDGE-MIB::dot1qPvid.<ifIndex> = ${action.vlanId} (search-summary-sourced confirmation, official HPE page 403'd to direct fetch — see mib-reference.md)`,
          },
        ];

      case 'vlan.setTrunkAllowed':
        // mib-reference.md: Q-BRIDGE-MIB::dot1qVlanStaticEgressPorts is a
        // per-VLAN PortList bitmask (not a per-port allowed-VLANs list),
        // so adding this port to each requested VLAN's egress set requires
        // a GET-then-modify-then-SET of that VLAN's existing bitmask — the
        // adapter can't compute the final bitmask value statically. One op
        // per VLAN ID, oid resolved by the caller the same way <ifIndex>
        // is resolved elsewhere; the <mergeBit> value is a marker for the
        // processor to GET the current bitmask, set this port's bit, and
        // SET the result back (same "resolved downstream" convention as
        // the <ifIndex> placeholder used throughout this file).
        return action.vlanIds.map((vlanId) => ({
          oid: `1.3.6.1.2.1.17.7.1.4.3.1.2.${vlanId}`, // Q-BRIDGE-MIB::dot1qVlanStaticEgressPorts.<vlanId>
          type: 'OctetString' as const,
          value: '<mergeBit:ifIndex>',
          description: `Q-BRIDGE-MIB::dot1qVlanStaticEgressPorts.${vlanId} — GET current PortList bitmask, set this port's (<ifIndex>) bit, SET result back (search-summary-sourced; only vendor in this project with a confirmed SNMP path for trunk-allowed-list specifically)`,
        }));

      case 'vlan.create':
        // mib-reference.md: RowStatus createAndGo(4) on
        // dot1qVlanStaticRowStatus, alongside setting dot1qVlanStaticName.
        // OIDs: dot1qVlan(4) -> dot1qVlanStaticTable(3) -> Entry(1) ->
        // Name(1) / RowStatus(5).
        return [
          {
            oid: `1.3.6.1.2.1.17.7.1.4.3.1.1.${action.vlanId}`, // Q-BRIDGE-MIB::dot1qVlanStaticName.<vlanId>
            type: 'OctetString',
            value: action.name,
            description: `Q-BRIDGE-MIB::dot1qVlanStaticName.${action.vlanId} = "${action.name}"`,
          },
          {
            oid: `1.3.6.1.2.1.17.7.1.4.3.1.5.${action.vlanId}`, // Q-BRIDGE-MIB::dot1qVlanStaticRowStatus.<vlanId>
            type: 'RowStatus',
            value: 4,
            description: `Q-BRIDGE-MIB::dot1qVlanStaticRowStatus.${action.vlanId} = createAndGo(4)`,
          },
        ];

      case 'config.save':
        // mib-reference.md: ARUBAWIRED-CONFIG-MIB::arubaWiredConfigurationCopyTable,
        // confirmed read-write, RowStatus-driven — same shape as Cisco's
        // CISCO-CONFIG-COPY-MIB. Root OID confirmed from source
        // (wndFeatures.20 = 1.3.6.1.4.1.47196.4.1.1.3.20); the exact
        // per-column numeric suffixes within the table were NOT enumerated
        // in this docs tree this session (mib-reference.md lists the
        // column names but not their column numbers) — flagged explicitly
        // per-op below rather than silently invented, verify against a
        // live device or the official SNMP/MIB guide before relying on
        // these exact trailing OID components.
        return [
          {
            oid: '1.3.6.1.4.1.47196.4.1.1.3.20.1.<col>.1', // ARUBAWIRED-CONFIG-MIB::arubaWiredConfigurationCopySourceFileType.1 — column suffix unconfirmed
            type: 'Integer',
            value: 3,
            description: 'ARUBAWIRED-CONFIG-MIB::arubaWiredConfigurationCopySourceFileType.1 = runningConfiguration(3) — table root confirmed, exact column index not enumerated this session',
          },
          {
            oid: '1.3.6.1.4.1.47196.4.1.1.3.20.1.<col>.1', // ARUBAWIRED-CONFIG-MIB::arubaWiredConfigurationCopyDestFileType.1 — column suffix unconfirmed
            type: 'Integer',
            value: 2,
            description: 'ARUBAWIRED-CONFIG-MIB::arubaWiredConfigurationCopyDestFileType.1 = startupConfiguration(2) — table root confirmed, exact column index not enumerated this session',
          },
        ];

      // Trunk native VLAN tag mode, STP mode/hardening, LACP membership,
      // port security, SNMP self-config: either no DeviceAction kind
      // represents them this phase, or (route/IP) no documented SNMP path
      // exists — correctly null.
      default:
        return null;
    }
  }

  buildReadbackCommand(action: DeviceAction): string | null {
    switch (action.kind) {
      case 'port.setAdminStatus':
      case 'port.setDescription':
      case 'vlan.setPvid':
      case 'vlan.setTrunkAllowed':
      case 'interface.setIpAddress':
        return `show interface ${action.interfaceName}`;
      case 'vlan.create':
        return 'show vlan';
      case 'route.static.upsert':
        // Not documented in cli-reference.md (no IP-routing show section) —
        // same out-of-docs confidence caveat as the CLI plan above.
        return 'show running-config';
      case 'config.save':
        return null;
      default:
        return null;
    }
  }

  parseReadback(action: DeviceAction, rawOutput: string): StructuredDiff {
    // Intentionally minimal this phase, matching cisco-ios.adapter.ts's
    // level of effort — enough to confirm the round trip, not a full
    // `show` output parser.
    if (action.kind === 'port.setAdminStatus') {
      const adminUp = !/administratively down/i.test(rawOutput);
      const operUp = /line protocol is up/i.test(rawOutput) || (/\bis up\b/i.test(rawOutput) && !/administratively down/i.test(rawOutput));
      return { changed: true, after: { adminUp, operUp }, note: rawOutput.slice(0, 400) };
    }
    if (action.kind === 'port.setDescription') {
      const match = rawOutput.match(/Description:\s*(.*)/i);
      return { changed: true, after: match?.[1]?.trim(), note: rawOutput.slice(0, 400) };
    }
    return { changed: true, after: rawOutput.slice(0, 400) };
  }
}
