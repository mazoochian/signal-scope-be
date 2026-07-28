import { DellOs10Adapter } from './dell-os10.adapter';
import { DeviceAction } from './vendor-adapter.interface';

describe('DellOs10Adapter', () => {
  const adapter = new DellOs10Adapter();

  it('has the expected profileId and interface naming pattern', () => {
    expect(adapter.profileId).toBe('dell-os10');
    expect(adapter.interfaceNamePattern.test('ethernet 1/1/2')).toBe(true);
    expect(adapter.interfaceNamePattern.test('ethernet1/1/2')).toBe(false);
    expect(adapter.interfaceNamePattern.test('GigabitEthernet0/1')).toBe(false);
  });

  it('has an OS10-shaped cliDialect: no enable step, immediate-apply, write memory to persist', () => {
    expect(adapter.cliDialect.pagingDisableCmd).toBeNull();
    expect(adapter.cliDialect.enableSequence).toBeNull();
    expect(adapter.cliDialect.negationKeyword).toBe('no');
    expect(adapter.cliDialect.candidateConfig).toBe(false);
    expect(adapter.cliDialect.saveOrCommit).toEqual({ kind: 'persist', commands: ['write memory'] });
  });

  describe('buildCliPlan', () => {
    it('port.setAdminStatus up', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: 'ethernet 1/1/2', adminStatus: 'up' };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure terminal',
        'interface ethernet 1/1/2',
        'no shutdown',
        'exit',
        'exit',
      ]);
    });

    it('port.setAdminStatus down', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: 'ethernet 1/1/2', adminStatus: 'down' };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure terminal',
        'interface ethernet 1/1/2',
        'shutdown',
        'exit',
        'exit',
      ]);
    });

    it('port.setDescription', () => {
      const action: DeviceAction = { kind: 'port.setDescription', interfaceName: 'ethernet 1/1/2', description: 'uplink-core1' };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure terminal',
        'interface ethernet 1/1/2',
        'description uplink-core1',
        'exit',
        'exit',
      ]);
    });

    it('vlan.setPvid uses switchport access vlan with no separate access-mode toggle', () => {
      const action: DeviceAction = { kind: 'vlan.setPvid', interfaceName: 'ethernet 1/1/2', vlanId: 10 };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure terminal',
        'interface ethernet 1/1/2',
        'switchport access vlan 10',
        'exit',
        'exit',
      ]);
    });

    it('vlan.setTrunkAllowed', () => {
      const action: DeviceAction = { kind: 'vlan.setTrunkAllowed', interfaceName: 'ethernet 1/1/2', vlanIds: [10, 20, 30] };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure terminal',
        'interface ethernet 1/1/2',
        'switchport mode trunk',
        'switchport trunk allowed vlan 10,20,30',
        'exit',
        'exit',
      ]);
    });

    it('vlan.create enters the VLAN interface context and does not attempt to name it', () => {
      const action: DeviceAction = { kind: 'vlan.create', vlanId: 25, name: 'corporate_100' };
      expect(adapter.buildCliPlan(action)).toEqual(['configure terminal', 'interface vlan 25', 'exit', 'exit']);
    });

    it('config.save', () => {
      const action: DeviceAction = { kind: 'config.save' };
      expect(adapter.buildCliPlan(action)).toEqual(['write memory']);
    });

    it('interface.setIpAddress', () => {
      const action: DeviceAction = {
        kind: 'interface.setIpAddress',
        interfaceName: 'ethernet 1/1/2',
        ipAddress: '10.0.0.1',
        prefixLength: 24,
      };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure terminal',
        'interface ethernet 1/1/2',
        'ip address 10.0.0.1/24',
        'exit',
        'exit',
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
        'exit',
      ]);
    });
  });

  describe('buildSnmpPlan — verified-absence behavior: every action returns null', () => {
    const cases: DeviceAction[] = [
      { kind: 'port.setAdminStatus', interfaceName: 'ethernet 1/1/2', adminStatus: 'up' },
      { kind: 'port.setDescription', interfaceName: 'ethernet 1/1/2', description: 'x' },
      { kind: 'vlan.setPvid', interfaceName: 'ethernet 1/1/2', vlanId: 10 },
      { kind: 'vlan.setTrunkAllowed', interfaceName: 'ethernet 1/1/2', vlanIds: [10, 20] },
      { kind: 'vlan.create', vlanId: 10, name: 'test' },
      { kind: 'config.save' },
      { kind: 'interface.setIpAddress', interfaceName: 'ethernet 1/1/2', ipAddress: '10.0.0.1', prefixLength: 24 },
      { kind: 'route.static.upsert', destinationCidr: '192.168.100.0/24', nextHop: '10.0.0.254' },
    ];

    it.each(cases)('$kind returns null (no config-write MIB exists on OS10)', (action) => {
      expect(adapter.buildSnmpPlan(action)).toBeNull();
    });
  });

  describe('buildReadbackCommand', () => {
    it('every write action reads back the whole running config (no scoped show confirmed)', () => {
      expect(adapter.buildReadbackCommand({ kind: 'port.setAdminStatus', interfaceName: 'ethernet 1/1/2', adminStatus: 'up' })).toBe(
        'show running-configuration',
      );
      expect(adapter.buildReadbackCommand({ kind: 'vlan.setPvid', interfaceName: 'ethernet 1/1/2', vlanId: 10 })).toBe(
        'show running-configuration',
      );
      expect(
        adapter.buildReadbackCommand({ kind: 'route.static.upsert', destinationCidr: '10.0.0.0/24', nextHop: '10.0.0.1' }),
      ).toBe('show running-configuration');
    });

    it('config.save has no readback', () => {
      expect(adapter.buildReadbackCommand({ kind: 'config.save' })).toBeNull();
    });
  });

  describe('parseReadback', () => {
    it('parses admin-up state from the interface block in running config', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: 'ethernet 1/1/2', adminStatus: 'up' };
      const raw = 'interface ethernet 1/1/2\r\n no shutdown\r\n!\r\ninterface ethernet 1/1/3\r\n shutdown\r\n!';
      const diff = adapter.parseReadback(action, raw);
      expect(diff.changed).toBe(true);
      expect(diff.after).toEqual({ adminUp: true });
    });

    it('parses admin-down state', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: 'ethernet 1/1/3', adminStatus: 'down' };
      const raw = 'interface ethernet 1/1/2\r\n no shutdown\r\n!\r\ninterface ethernet 1/1/3\r\n shutdown\r\n!';
      const diff = adapter.parseReadback(action, raw);
      expect(diff.after).toEqual({ adminUp: false });
    });

    it('parses description from the interface block', () => {
      const action: DeviceAction = { kind: 'port.setDescription', interfaceName: 'ethernet 1/1/2', description: 'uplink-core1' };
      const raw = 'interface ethernet 1/1/2\r\n description uplink-core1\r\n no shutdown\r\n!';
      const diff = adapter.parseReadback(action, raw);
      expect(diff.after).toBe('uplink-core1');
    });
  });
});
