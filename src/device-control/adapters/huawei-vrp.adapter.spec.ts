import { HuaweiVrpAdapter } from './huawei-vrp.adapter';
import { DeviceAction } from './vendor-adapter.interface';

describe('HuaweiVrpAdapter', () => {
  const adapter = new HuaweiVrpAdapter();

  it('has the expected profileId and interface naming pattern', () => {
    expect(adapter.profileId).toBe('huawei-vrp');
    expect(adapter.interfaceNamePattern.test('GigabitEthernet0/0/1')).toBe(true);
    // Two-part Cisco-style naming should NOT match — VRP is three-part.
    expect(adapter.interfaceNamePattern.test('GigabitEthernet0/1')).toBe(false);
  });

  it('has a VRP-shaped cliDialect distinct from Cisco', () => {
    expect(adapter.cliDialect.pagingDisableCmd).toBe('screen-length 0 temporary');
    expect(adapter.cliDialect.enableSequence).toBeNull();
    expect(adapter.cliDialect.negationKeyword).toBe('undo');
    expect(adapter.cliDialect.candidateConfig).toBe(false);
    expect(adapter.cliDialect.saveOrCommit).toEqual({ kind: 'persist', commands: ['save'] });
  });

  describe('buildCliPlan', () => {
    it('port.setAdminStatus up', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: 'GigabitEthernet0/0/1', adminStatus: 'up' };
      expect(adapter.buildCliPlan(action)).toEqual([
        'system-view',
        'interface GigabitEthernet0/0/1',
        'undo shutdown',
        'quit',
      ]);
    });

    it('port.setAdminStatus down', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: 'GigabitEthernet0/0/1', adminStatus: 'down' };
      expect(adapter.buildCliPlan(action)).toEqual([
        'system-view',
        'interface GigabitEthernet0/0/1',
        'shutdown',
        'quit',
      ]);
    });

    it('port.setDescription', () => {
      const action: DeviceAction = { kind: 'port.setDescription', interfaceName: 'GigabitEthernet0/0/1', description: 'jest-uplink' };
      expect(adapter.buildCliPlan(action)).toEqual([
        'system-view',
        'interface GigabitEthernet0/0/1',
        'description jest-uplink',
        'quit',
      ]);
    });

    it('vlan.setPvid', () => {
      const action: DeviceAction = { kind: 'vlan.setPvid', interfaceName: 'GigabitEthernet0/0/1', vlanId: 10 };
      expect(adapter.buildCliPlan(action)).toEqual([
        'system-view',
        'interface GigabitEthernet0/0/1',
        'port link-type access',
        'port default vlan 10',
        'quit',
      ]);
    });

    it('vlan.setTrunkAllowed', () => {
      const action: DeviceAction = { kind: 'vlan.setTrunkAllowed', interfaceName: 'GigabitEthernet0/0/1', vlanIds: [10, 20, 30] };
      expect(adapter.buildCliPlan(action)).toEqual([
        'system-view',
        'interface GigabitEthernet0/0/1',
        'port link-type trunk',
        'port trunk allow-pass vlan 10 20 30',
        'quit',
      ]);
    });

    it('vlan.create', () => {
      const action: DeviceAction = { kind: 'vlan.create', vlanId: 25, name: 'corporate_100' };
      expect(adapter.buildCliPlan(action)).toEqual([
        'system-view',
        'vlan 25',
        'description corporate_100',
        'quit',
      ]);
    });

    it('config.save', () => {
      const action: DeviceAction = { kind: 'config.save' };
      expect(adapter.buildCliPlan(action)).toEqual(['save']);
    });

    it('interface.setIpAddress', () => {
      const action: DeviceAction = {
        kind: 'interface.setIpAddress',
        interfaceName: 'GigabitEthernet0/0/1',
        ipAddress: '10.0.0.1',
        prefixLength: 24,
      };
      expect(adapter.buildCliPlan(action)).toEqual([
        'system-view',
        'interface GigabitEthernet0/0/1',
        'ip address 10.0.0.1 255.255.255.0',
        'quit',
      ]);
    });

    it('route.static.upsert', () => {
      const action: DeviceAction = {
        kind: 'route.static.upsert',
        destinationCidr: '192.168.100.0/24',
        nextHop: '10.0.0.254',
      };
      expect(adapter.buildCliPlan(action)).toEqual([
        'system-view',
        'ip route-static 192.168.100.0 255.255.255.0 10.0.0.254',
      ]);
    });
  });

  describe('buildSnmpPlan — the narrow-write-surface behavior', () => {
    it('port.setAdminStatus returns the IF-MIB::ifAdminStatus SET', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: 'GigabitEthernet0/0/1', adminStatus: 'up' };
      expect(adapter.buildSnmpPlan(action)).toEqual([
        {
          oid: '1.3.6.1.2.1.2.2.1.7.<ifIndex>',
          type: 'Integer',
          value: 1,
          description: 'IF-MIB::ifAdminStatus.<ifIndex> = up(1)',
        },
      ]);
    });

    it('port.setDescription returns the IF-MIB::ifAlias SET', () => {
      const action: DeviceAction = { kind: 'port.setDescription', interfaceName: 'GigabitEthernet0/0/1', description: 'jest-uplink' };
      expect(adapter.buildSnmpPlan(action)).toEqual([
        {
          oid: '1.3.6.1.2.1.31.1.1.1.18.<ifIndex>',
          type: 'OctetString',
          value: 'jest-uplink',
          description: 'IF-MIB::ifAlias.<ifIndex> = "jest-uplink"',
        },
      ]);
    });

    it('vlan.setPvid returns the confirmed Q-BRIDGE-MIB::dot1qPvid SET — the one genuine SNMP write path on this vendor', () => {
      const action: DeviceAction = { kind: 'vlan.setPvid', interfaceName: 'GigabitEthernet0/0/1', vlanId: 10 };
      expect(adapter.buildSnmpPlan(action)).toEqual([
        {
          oid: '1.3.6.1.2.1.17.7.1.4.5.1.1.<bridgePort>',
          type: 'Integer',
          value: 10,
          description: 'Q-BRIDGE-MIB::dot1qPvid.<bridgePort> = 10',
        },
      ]);
    });

    it('vlan.setTrunkAllowed returns null — write support not independently confirmed', () => {
      const action: DeviceAction = { kind: 'vlan.setTrunkAllowed', interfaceName: 'GigabitEthernet0/0/1', vlanIds: [10, 20] };
      expect(adapter.buildSnmpPlan(action)).toBeNull();
    });

    it('vlan.create returns null — not independently confirmed for Huawei', () => {
      const action: DeviceAction = { kind: 'vlan.create', vlanId: 10, name: 'test' };
      expect(adapter.buildSnmpPlan(action)).toBeNull();
    });

    it('config.save returns null — no confirmed SNMP config-save trigger', () => {
      const action: DeviceAction = { kind: 'config.save' };
      expect(adapter.buildSnmpPlan(action)).toBeNull();
    });

    it('interface.setIpAddress returns null', () => {
      const action: DeviceAction = {
        kind: 'interface.setIpAddress',
        interfaceName: 'GigabitEthernet0/0/1',
        ipAddress: '10.0.0.1',
        prefixLength: 24,
      };
      expect(adapter.buildSnmpPlan(action)).toBeNull();
    });

    it('route.static.upsert returns null', () => {
      const action: DeviceAction = { kind: 'route.static.upsert', destinationCidr: '192.168.100.0/24', nextHop: '10.0.0.254' };
      expect(adapter.buildSnmpPlan(action)).toBeNull();
    });
  });

  describe('buildReadbackCommand', () => {
    it('port.setAdminStatus / port.setDescription / interface.setIpAddress use display interface <name>', () => {
      expect(adapter.buildReadbackCommand({ kind: 'port.setAdminStatus', interfaceName: 'GigabitEthernet0/0/1', adminStatus: 'up' })).toBe(
        'display interface GigabitEthernet0/0/1',
      );
      expect(adapter.buildReadbackCommand({ kind: 'port.setDescription', interfaceName: 'GigabitEthernet0/0/1', description: 'x' })).toBe(
        'display interface GigabitEthernet0/0/1',
      );
      expect(
        adapter.buildReadbackCommand({ kind: 'interface.setIpAddress', interfaceName: 'GigabitEthernet0/0/1', ipAddress: '10.0.0.1', prefixLength: 24 }),
      ).toBe('display interface GigabitEthernet0/0/1');
    });

    it('vlan.setPvid uses display vlan <id>', () => {
      expect(adapter.buildReadbackCommand({ kind: 'vlan.setPvid', interfaceName: 'GigabitEthernet0/0/1', vlanId: 10 })).toBe('display vlan 10');
    });

    it('vlan.create uses display vlan', () => {
      expect(adapter.buildReadbackCommand({ kind: 'vlan.create', vlanId: 10, name: 'x' })).toBe('display vlan');
    });

    it('vlan.setTrunkAllowed uses display interface <name>', () => {
      expect(adapter.buildReadbackCommand({ kind: 'vlan.setTrunkAllowed', interfaceName: 'GigabitEthernet0/0/1', vlanIds: [10] })).toBe(
        'display interface GigabitEthernet0/0/1',
      );
    });

    it('route.static.upsert uses display ip routing-table', () => {
      expect(
        adapter.buildReadbackCommand({ kind: 'route.static.upsert', destinationCidr: '10.0.0.0/24', nextHop: '10.0.0.1' }),
      ).toBe('display ip routing-table');
    });

    it('config.save has no readback', () => {
      expect(adapter.buildReadbackCommand({ kind: 'config.save' })).toBeNull();
    });
  });

  describe('parseReadback', () => {
    it('parses admin/oper up state from VRP display interface output', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: 'GigabitEthernet0/0/1', adminStatus: 'up' };
      const raw = 'GigabitEthernet0/0/1 current state : UP\r\nLine protocol current state : UP\r\nDescription :';
      const diff = adapter.parseReadback(action, raw);
      expect(diff.changed).toBe(true);
      expect(diff.after).toEqual({ adminUp: true, operUp: true });
    });

    it('parses administratively down state', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: 'GigabitEthernet0/0/1', adminStatus: 'down' };
      const raw = 'GigabitEthernet0/0/1 current state : Administratively DOWN\r\nLine protocol current state : DOWN';
      const diff = adapter.parseReadback(action, raw);
      expect(diff.after).toEqual({ adminUp: false, operUp: false });
    });

    it('parses description from readback output', () => {
      const action: DeviceAction = { kind: 'port.setDescription', interfaceName: 'GigabitEthernet0/0/1', description: 'jest-uplink' };
      const raw = 'GigabitEthernet0/0/1 current state : UP\r\nLine protocol current state : UP\r\nDescription : jest-uplink';
      const diff = adapter.parseReadback(action, raw);
      expect(diff.after).toBe('jest-uplink');
    });
  });
});
