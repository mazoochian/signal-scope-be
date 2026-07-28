import { ExtremeExosAdapter } from './extreme-exos.adapter';
import { DeviceAction } from './vendor-adapter.interface';

describe('ExtremeExosAdapter', () => {
  const adapter = new ExtremeExosAdapter();

  it('has the expected profileId and interface naming pattern', () => {
    expect(adapter.profileId).toBe('extreme-exos');
    expect(adapter.interfaceNamePattern.test('1:3')).toBe(true);
    expect(adapter.interfaceNamePattern.test('3')).toBe(true);
    expect(adapter.interfaceNamePattern.test('GigabitEthernet0/1')).toBe(false);
  });

  it('has a modeless cliDialect (no enable sequence, no negation particle)', () => {
    expect(adapter.cliDialect.pagingDisableCmd).toBe('disable clipaging');
    expect(adapter.cliDialect.enableSequence).toBeNull();
    expect(adapter.cliDialect.negationKeyword).toBeNull();
    expect(adapter.cliDialect.candidateConfig).toBe(false);
    expect(adapter.cliDialect.saveOrCommit).toEqual({ kind: 'persist', commands: ['save configuration'] });
  });

  describe('buildCliPlan', () => {
    it('port.setAdminStatus up is a single self-contained line', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: '1:3', adminStatus: 'up' };
      expect(adapter.buildCliPlan(action)).toEqual(['enable port 1:3']);
    });

    it('port.setAdminStatus down', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: '1:3', adminStatus: 'down' };
      expect(adapter.buildCliPlan(action)).toEqual(['disable port 1:3']);
    });

    it('port.setDescription quotes the description', () => {
      const action: DeviceAction = { kind: 'port.setDescription', interfaceName: '1:3', description: 'uplink to core-sw1' };
      expect(adapter.buildCliPlan(action)).toEqual(['configure ports 1:3 description-string "uplink to core-sw1"']);
    });

    it('vlan.setPvid uses untagged VLAN membership, no sub-mode', () => {
      const action: DeviceAction = { kind: 'vlan.setPvid', interfaceName: '1:3', vlanId: 100 };
      expect(adapter.buildCliPlan(action)).toEqual(['configure vlan 100 add ports 1:3 untagged']);
    });

    it('vlan.setTrunkAllowed emits one line per VLAN', () => {
      const action: DeviceAction = { kind: 'vlan.setTrunkAllowed', interfaceName: '1:3', vlanIds: [10, 20, 30] };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure vlan 10 add ports 1:3 tagged',
        'configure vlan 20 add ports 1:3 tagged',
        'configure vlan 30 add ports 1:3 tagged',
      ]);
    });

    it('vlan.create combines create + tag in one line', () => {
      const action: DeviceAction = { kind: 'vlan.create', vlanId: 100, name: 'accounting' };
      expect(adapter.buildCliPlan(action)).toEqual(['create vlan accounting tag 100']);
    });

    it('config.save', () => {
      expect(adapter.buildCliPlan({ kind: 'config.save' })).toEqual(['save configuration']);
    });

    it('interface.setIpAddress returns null — EXOS L3 is VLAN-SVI-based, not physical-port-based', () => {
      const action: DeviceAction = { kind: 'interface.setIpAddress', interfaceName: '1:3', ipAddress: '10.0.0.1', prefixLength: 24 };
      expect(adapter.buildCliPlan(action)).toBeNull();
    });

    it('route.static.upsert returns null — out of scope for the consulted docs', () => {
      const action: DeviceAction = { kind: 'route.static.upsert', destinationCidr: '192.168.100.0/24', nextHop: '10.0.0.254' };
      expect(adapter.buildCliPlan(action)).toBeNull();
    });
  });

  describe('buildSnmpPlan — narrow, explicitly-scoped write surface', () => {
    it('port.setAdminStatus returns the documented IF-MIB::ifAdminStatus SET', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: '1:3', adminStatus: 'up' };
      expect(adapter.buildSnmpPlan(action)).toEqual([
        { oid: '1.3.6.1.2.1.2.2.1.7.<ifIndex>', type: 'Integer', value: 1, description: 'IF-MIB::ifAdminStatus.<ifIndex> = up(1)' },
      ]);
    });

    it('port.setDescription returns null — ifAlias is not in overview.md\'s confirmed write-scope table', () => {
      const action: DeviceAction = { kind: 'port.setDescription', interfaceName: '1:3', description: 'x' };
      expect(adapter.buildSnmpPlan(action)).toBeNull();
    });

    it('vlan.setPvid returns the confirmed Q-BRIDGE-MIB::dot1qPvid SET', () => {
      const action: DeviceAction = { kind: 'vlan.setPvid', interfaceName: '1:3', vlanId: 100 };
      expect(adapter.buildSnmpPlan(action)).toEqual([
        { oid: '1.3.6.1.2.1.17.7.1.4.5.1.1.<ifIndex>', type: 'Integer', value: 100, description: 'Q-BRIDGE-MIB::dot1qPvid.<ifIndex> = 100' },
      ]);
    });

    it('vlan.setTrunkAllowed returns null — dot1qVlanStaticEgressPorts needs an unsafe read-modify-write', () => {
      const action: DeviceAction = { kind: 'vlan.setTrunkAllowed', interfaceName: '1:3', vlanIds: [10, 20] };
      expect(adapter.buildSnmpPlan(action)).toBeNull();
    });

    it('vlan.create returns RowStatus createAndGo + name SET', () => {
      const action: DeviceAction = { kind: 'vlan.create', vlanId: 100, name: 'accounting' };
      expect(adapter.buildSnmpPlan(action)).toEqual([
        {
          oid: '1.3.6.1.2.1.17.7.1.4.3.1.5.100',
          type: 'RowStatus',
          value: 4,
          description: 'Q-BRIDGE-MIB::dot1qVlanStaticRowStatus.100 = createAndGo(4) — EXOS only implements createAndGo/destroy, not full 2-phase RowStatus',
        },
        {
          oid: '1.3.6.1.2.1.17.7.1.4.3.1.1.100',
          type: 'OctetString',
          value: 'accounting',
          description: 'Q-BRIDGE-MIB::dot1qVlanStaticName.100 = "accounting"',
        },
      ]);
    });

    it('config.save returns the provisional EXTREME-SYSTEM-MIB save-trigger SET', () => {
      expect(adapter.buildSnmpPlan({ kind: 'config.save' })).toEqual([
        {
          oid: '1.3.6.1.4.1.1916.1.1.1.1.3',
          type: 'Integer',
          value: 1,
          description:
            'EXTREME-SYSTEM-MIB::extremeSaveConfiguration (provisional OID, third-party-mirror-sourced per mib-reference.md — not independently confirmed against Extreme\'s own MIB text) = save-trigger(1)',
        },
      ]);
    });

    it('interface.setIpAddress and route.static.upsert return null', () => {
      expect(
        adapter.buildSnmpPlan({ kind: 'interface.setIpAddress', interfaceName: '1:3', ipAddress: '10.0.0.1', prefixLength: 24 }),
      ).toBeNull();
      expect(
        adapter.buildSnmpPlan({ kind: 'route.static.upsert', destinationCidr: '10.0.0.0/24', nextHop: '10.0.0.1' }),
      ).toBeNull();
    });
  });

  describe('buildReadbackCommand', () => {
    it('port.setAdminStatus / port.setDescription use show ports <name> information', () => {
      expect(adapter.buildReadbackCommand({ kind: 'port.setAdminStatus', interfaceName: '1:3', adminStatus: 'up' })).toBe(
        'show ports 1:3 information',
      );
      expect(adapter.buildReadbackCommand({ kind: 'port.setDescription', interfaceName: '1:3', description: 'x' })).toBe(
        'show ports 1:3 information',
      );
    });

    it('vlan.setPvid / vlan.setTrunkAllowed use the port-centric show ports <name> vlan', () => {
      expect(adapter.buildReadbackCommand({ kind: 'vlan.setPvid', interfaceName: '1:3', vlanId: 100 })).toBe('show ports 1:3 vlan');
      expect(adapter.buildReadbackCommand({ kind: 'vlan.setTrunkAllowed', interfaceName: '1:3', vlanIds: [10] })).toBe(
        'show ports 1:3 vlan',
      );
    });

    it('vlan.create uses show vlan', () => {
      expect(adapter.buildReadbackCommand({ kind: 'vlan.create', vlanId: 100, name: 'accounting' })).toBe('show vlan');
    });

    it('config.save has no readback', () => {
      expect(adapter.buildReadbackCommand({ kind: 'config.save' })).toBeNull();
    });
  });

  describe('parseReadback', () => {
    it('parses admin/link state from show ports information output', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: '1:3', adminStatus: 'up' };
      const raw = 'Port: 1:3\r\nAdmin State: Enabled\r\nLink State: Active\r\n';
      const diff = adapter.parseReadback(action, raw);
      expect(diff.changed).toBe(true);
      expect(diff.after).toEqual({ adminUp: true, operUp: true });
    });

    it('parses disabled/ready state', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: '1:3', adminStatus: 'down' };
      const raw = 'Port: 1:3\r\nAdmin State: Disabled\r\nLink State: Ready\r\n';
      const diff = adapter.parseReadback(action, raw);
      expect(diff.after).toEqual({ adminUp: false, operUp: false });
    });

    it('parses description from readback output', () => {
      const action: DeviceAction = { kind: 'port.setDescription', interfaceName: '1:3', description: 'uplink to core-sw1' };
      const raw = 'Port: 1:3\r\nDescription: uplink to core-sw1\r\nAdmin State: Enabled\r\n';
      const diff = adapter.parseReadback(action, raw);
      expect(diff.after).toBe('uplink to core-sw1');
    });
  });
});
