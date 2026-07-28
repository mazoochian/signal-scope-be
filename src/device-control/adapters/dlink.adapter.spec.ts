import { DlinkAdapter } from './dlink.adapter';
import { DeviceAction } from './vendor-adapter.interface';

describe('DlinkAdapter', () => {
  const adapter = new DlinkAdapter();

  it('has the expected profileId and interface naming pattern', () => {
    expect(adapter.profileId).toBe('dlink');
    expect(adapter.interfaceNamePattern.test('1/0/5')).toBe(true);
    expect(adapter.interfaceNamePattern.test('1:1')).toBe(false); // classic xStack shape, not modeled here
    expect(adapter.interfaceNamePattern.test('GigabitEthernet0/1')).toBe(false);
  });

  it('has a Cisco-like cliDialect (confirmed fields only)', () => {
    expect(adapter.cliDialect.negationKeyword).toBe('no');
    expect(adapter.cliDialect.candidateConfig).toBe(false);
    expect(adapter.cliDialect.saveOrCommit).toEqual({ kind: 'persist', commands: ['copy running-config startup-config'] });
    expect(adapter.cliDialect.pagingDisableCmd).toBeNull();
  });

  describe('buildCliPlan', () => {
    it('port.setAdminStatus up', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: '1/0/5', adminStatus: 'up' };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure terminal',
        'interface ethernet 1/0/5',
        'no shutdown',
        'end',
      ]);
    });

    it('port.setAdminStatus down', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: '1/0/5', adminStatus: 'down' };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure terminal',
        'interface ethernet 1/0/5',
        'shutdown',
        'end',
      ]);
    });

    it('port.setDescription', () => {
      const action: DeviceAction = { kind: 'port.setDescription', interfaceName: '1/0/5', description: 'uplink-core1' };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure terminal',
        'interface ethernet 1/0/5',
        'description uplink-core1',
        'end',
      ]);
    });

    it('vlan.setPvid', () => {
      const action: DeviceAction = { kind: 'vlan.setPvid', interfaceName: '1/0/5', vlanId: 10 };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure terminal',
        'interface ethernet 1/0/5',
        'switchport mode access',
        'switchport access vlan 10',
        'end',
      ]);
    });

    it('vlan.setTrunkAllowed uses the D-Link-specific "tagged" keyword', () => {
      const action: DeviceAction = { kind: 'vlan.setTrunkAllowed', interfaceName: '1/0/5', vlanIds: [10, 20, 30] };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure terminal',
        'interface ethernet 1/0/5',
        'switchport mode trunk',
        'switchport trunk allowed vlan tagged 10,20,30',
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
      expect(adapter.buildCliPlan(action)).toEqual(['copy running-config startup-config']);
    });

    it('interface.setIpAddress', () => {
      const action: DeviceAction = {
        kind: 'interface.setIpAddress',
        interfaceName: '1/0/5',
        ipAddress: '10.0.0.1',
        prefixLength: 24,
      };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure terminal',
        'interface ethernet 1/0/5',
        'ip address 10.0.0.1 255.255.255.0',
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
        'ip route 192.168.100.0 255.255.255.0 10.0.0.254',
        'end',
      ]);
    });
  });

  describe('buildSnmpPlan — no confirmed SNMP write path for D-Link', () => {
    const actions: DeviceAction[] = [
      { kind: 'port.setAdminStatus', interfaceName: '1/0/5', adminStatus: 'up' },
      { kind: 'port.setDescription', interfaceName: '1/0/5', description: 'x' },
      { kind: 'vlan.setPvid', interfaceName: '1/0/5', vlanId: 10 },
      { kind: 'vlan.setTrunkAllowed', interfaceName: '1/0/5', vlanIds: [10] },
      { kind: 'vlan.create', vlanId: 10, name: 'x' },
      { kind: 'config.save' },
      { kind: 'interface.setIpAddress', interfaceName: '1/0/5', ipAddress: '10.0.0.1', prefixLength: 24 },
      { kind: 'route.static.upsert', destinationCidr: '10.0.0.0/24', nextHop: '10.0.0.1' },
    ];

    it.each(actions)('$kind returns null', (action) => {
      expect(adapter.buildSnmpPlan(action)).toBeNull();
    });
  });

  describe('buildReadbackCommand', () => {
    it('port actions use show interfaces ethernet <name>', () => {
      expect(adapter.buildReadbackCommand({ kind: 'port.setAdminStatus', interfaceName: '1/0/5', adminStatus: 'up' })).toBe(
        'show interfaces ethernet 1/0/5',
      );
      expect(adapter.buildReadbackCommand({ kind: 'port.setDescription', interfaceName: '1/0/5', description: 'x' })).toBe(
        'show interfaces ethernet 1/0/5',
      );
    });

    it('vlan actions use show vlan', () => {
      expect(adapter.buildReadbackCommand({ kind: 'vlan.setPvid', interfaceName: '1/0/5', vlanId: 10 })).toBe('show vlan');
      expect(adapter.buildReadbackCommand({ kind: 'vlan.create', vlanId: 10, name: 'x' })).toBe('show vlan');
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
    it('parses admin/oper status', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: '1/0/5', adminStatus: 'up' };
      const raw = 'Ethernet1/0/5 is up, line protocol is up (connected)\r\n  Description: \r\n';
      const diff = adapter.parseReadback(action, raw);
      expect(diff.changed).toBe(true);
      expect(diff.after).toEqual({ adminUp: true, operUp: true });
    });

    it('parses administratively down state', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: '1/0/5', adminStatus: 'down' };
      const raw = 'Ethernet1/0/5 is administratively down, line protocol is down (notconnect)';
      const diff = adapter.parseReadback(action, raw);
      expect(diff.after).toEqual({ adminUp: false, operUp: false });
    });

    it('parses description from readback output', () => {
      const action: DeviceAction = { kind: 'port.setDescription', interfaceName: '1/0/5', description: 'uplink-core1' };
      const raw = 'Ethernet1/0/5 is up, line protocol is up (connected)\r\n  Description: uplink-core1\r\n';
      const diff = adapter.parseReadback(action, raw);
      expect(diff.after).toBe('uplink-core1');
    });
  });
});
