import { AristaEosAdapter } from './arista-eos.adapter';
import { DeviceAction } from './vendor-adapter.interface';

describe('AristaEosAdapter', () => {
  const adapter = new AristaEosAdapter();

  it('has the expected profileId and interface naming pattern', () => {
    expect(adapter.profileId).toBe('arista-eos');
    expect(adapter.interfaceNamePattern.test('Ethernet1')).toBe(true);
    expect(adapter.interfaceNamePattern.test('Ethernet1/1')).toBe(true);
    // No speed-encoded type prefix like Cisco's GigabitEthernet0/1.
    expect(adapter.interfaceNamePattern.test('GigabitEthernet0/1')).toBe(false);
  });

  it('has an IOS-shaped cliDialect with EOS-specific save command', () => {
    expect(adapter.cliDialect.pagingDisableCmd).toBe('terminal length 0');
    expect(adapter.cliDialect.enableSequence).toEqual(['enable']);
    expect(adapter.cliDialect.negationKeyword).toBe('no');
    expect(adapter.cliDialect.candidateConfig).toBe(false);
    expect(adapter.cliDialect.saveOrCommit).toEqual({ kind: 'persist', commands: ['write memory'] });
  });

  describe('buildCliPlan', () => {
    it('port.setAdminStatus up', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: 'Ethernet1', adminStatus: 'up' };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure terminal',
        'interface Ethernet1',
        'no shutdown',
        'end',
      ]);
    });

    it('port.setAdminStatus down', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: 'Ethernet1', adminStatus: 'down' };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure terminal',
        'interface Ethernet1',
        'shutdown',
        'end',
      ]);
    });

    it('port.setDescription', () => {
      const action: DeviceAction = { kind: 'port.setDescription', interfaceName: 'Ethernet1', description: 'uplink-core1' };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure terminal',
        'interface Ethernet1',
        'description uplink-core1',
        'end',
      ]);
    });

    it('vlan.setPvid', () => {
      const action: DeviceAction = { kind: 'vlan.setPvid', interfaceName: 'Ethernet1', vlanId: 10 };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure terminal',
        'interface Ethernet1',
        'switchport mode access',
        'switchport access vlan 10',
        'end',
      ]);
    });

    it('vlan.setTrunkAllowed', () => {
      const action: DeviceAction = { kind: 'vlan.setTrunkAllowed', interfaceName: 'Ethernet1', vlanIds: [10, 20, 30] };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure terminal',
        'interface Ethernet1',
        'switchport mode trunk',
        'switchport trunk allowed vlan 10,20,30',
        'end',
      ]);
    });

    it('vlan.create', () => {
      const action: DeviceAction = { kind: 'vlan.create', vlanId: 25, name: 'corporate_100' };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure terminal',
        'vlan 25',
        'name corporate_100',
        'end',
      ]);
    });

    it('config.save', () => {
      const action: DeviceAction = { kind: 'config.save' };
      expect(adapter.buildCliPlan(action)).toEqual(['write memory']);
    });

    it('interface.setIpAddress', () => {
      const action: DeviceAction = {
        kind: 'interface.setIpAddress',
        interfaceName: 'Ethernet1',
        ipAddress: '10.0.0.1',
        prefixLength: 24,
      };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure terminal',
        'interface Ethernet1',
        'ip address 10.0.0.1/24',
        'end',
      ]);
    });

    it('route.static.upsert', () => {
      const action: DeviceAction = {
        kind: 'route.static.upsert',
        destinationCidr: '192.168.100.0/24',
        nextHop: '10.0.0.254',
      };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure terminal',
        'ip route 192.168.100.0/24 10.0.0.254',
        'end',
      ]);
    });
  });

  describe('buildSnmpPlan — the critical narrow-write-surface behavior', () => {
    it('port.setAdminStatus returns the confirmed IF-MIB::ifAdminStatus SET', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: 'Ethernet1', adminStatus: 'up' };
      expect(adapter.buildSnmpPlan(action)).toEqual([
        {
          oid: '1.3.6.1.2.1.2.2.1.7.<ifIndex>',
          type: 'Integer',
          value: 1,
          description: 'IF-MIB::ifAdminStatus.<ifIndex> = up(1)',
        },
      ]);
    });

    it('port.setAdminStatus down maps to value 2', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: 'Ethernet1', adminStatus: 'down' };
      expect(adapter.buildSnmpPlan(action)).toEqual([
        {
          oid: '1.3.6.1.2.1.2.2.1.7.<ifIndex>',
          type: 'Integer',
          value: 2,
          description: 'IF-MIB::ifAdminStatus.<ifIndex> = down(2)',
        },
      ]);
    });

    it('port.setDescription returns the confirmed IF-MIB::ifAlias SET', () => {
      const action: DeviceAction = { kind: 'port.setDescription', interfaceName: 'Ethernet1', description: 'uplink-core1' };
      expect(adapter.buildSnmpPlan(action)).toEqual([
        {
          oid: '1.3.6.1.2.1.31.1.1.1.18.<ifIndex>',
          type: 'OctetString',
          value: 'uplink-core1',
          description: 'IF-MIB::ifAlias.<ifIndex> = "uplink-core1"',
        },
      ]);
    });

    it('vlan.setPvid returns null — no CISCO-VLAN-MEMBERSHIP-MIB equivalent on Arista', () => {
      const action: DeviceAction = { kind: 'vlan.setPvid', interfaceName: 'Ethernet1', vlanId: 10 };
      expect(adapter.buildSnmpPlan(action)).toBeNull();
    });

    it('vlan.setTrunkAllowed returns null — no confirmed SNMP write path', () => {
      const action: DeviceAction = { kind: 'vlan.setTrunkAllowed', interfaceName: 'Ethernet1', vlanIds: [10, 20] };
      expect(adapter.buildSnmpPlan(action)).toBeNull();
    });

    it('vlan.create returns null', () => {
      const action: DeviceAction = { kind: 'vlan.create', vlanId: 10, name: 'test' };
      expect(adapter.buildSnmpPlan(action)).toBeNull();
    });

    it('config.save returns null — ARISTA-CONFIG-COPY-MIB has no confirmed SET trigger', () => {
      const action: DeviceAction = { kind: 'config.save' };
      expect(adapter.buildSnmpPlan(action)).toBeNull();
    });

    it('interface.setIpAddress returns null', () => {
      const action: DeviceAction = {
        kind: 'interface.setIpAddress',
        interfaceName: 'Ethernet1',
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
    it('port.setAdminStatus / port.setDescription use show interfaces <name>', () => {
      expect(adapter.buildReadbackCommand({ kind: 'port.setAdminStatus', interfaceName: 'Ethernet1', adminStatus: 'up' })).toBe(
        'show interfaces Ethernet1',
      );
      expect(adapter.buildReadbackCommand({ kind: 'port.setDescription', interfaceName: 'Ethernet1', description: 'x' })).toBe(
        'show interfaces Ethernet1',
      );
    });

    it('vlan.setPvid / vlan.create use show vlan', () => {
      expect(adapter.buildReadbackCommand({ kind: 'vlan.setPvid', interfaceName: 'Ethernet1', vlanId: 10 })).toBe('show vlan');
      expect(adapter.buildReadbackCommand({ kind: 'vlan.create', vlanId: 10, name: 'x' })).toBe('show vlan');
    });

    it('vlan.setTrunkAllowed uses show interfaces trunk', () => {
      expect(adapter.buildReadbackCommand({ kind: 'vlan.setTrunkAllowed', interfaceName: 'Ethernet1', vlanIds: [10] })).toBe(
        'show interfaces trunk',
      );
    });

    it('route.static.upsert uses show ip route static', () => {
      expect(
        adapter.buildReadbackCommand({ kind: 'route.static.upsert', destinationCidr: '10.0.0.0/24', nextHop: '10.0.0.1' }),
      ).toBe('show ip route static');
    });

    it('config.save has no readback', () => {
      expect(adapter.buildReadbackCommand({ kind: 'config.save' })).toBeNull();
    });
  });

  describe('parseReadback', () => {
    it('parses admin/oper status from EOS show interfaces output', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: 'Ethernet1', adminStatus: 'up' };
      const raw = 'Ethernet1 is up, line protocol is up (connected)\r\n  Description: \r\n  Hardware is Ethernet';
      const diff = adapter.parseReadback(action, raw);
      expect(diff.changed).toBe(true);
      expect(diff.after).toEqual({ adminUp: true, operUp: true });
    });

    it('parses administratively down state', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: 'Ethernet1', adminStatus: 'down' };
      const raw = 'Ethernet1 is administratively down, line protocol is down (notconnect)';
      const diff = adapter.parseReadback(action, raw);
      expect(diff.after).toEqual({ adminUp: false, operUp: false });
    });

    it('parses description from readback output', () => {
      const action: DeviceAction = { kind: 'port.setDescription', interfaceName: 'Ethernet1', description: 'uplink-core1' };
      const raw = 'Ethernet1 is up, line protocol is up (connected)\r\n  Description: uplink-core1\r\n  Hardware is Ethernet';
      const diff = adapter.parseReadback(action, raw);
      expect(diff.after).toBe('uplink-core1');
    });
  });
});
