import { FortinetAdapter } from './fortinet.adapter';
import { DeviceAction } from './vendor-adapter.interface';

describe('FortinetAdapter', () => {
  const adapter = new FortinetAdapter();

  it('has the expected profileId and interface naming pattern', () => {
    expect(adapter.profileId).toBe('fortinet');
    expect(adapter.interfaceNamePattern.test('port5')).toBe(true);
    expect(adapter.interfaceNamePattern.test('port12')).toBe(true);
    expect(adapter.interfaceNamePattern.test('GigabitEthernet0/1')).toBe(false);
  });

  it('has the FortiOS block-syntax cliDialect with auto-save-on-end semantics', () => {
    expect(adapter.cliDialect.pagingDisableCmd).toBeNull();
    expect(adapter.cliDialect.enableSequence).toBeNull();
    expect(adapter.cliDialect.negationKeyword).toBe('unset');
    expect(adapter.cliDialect.candidateConfig).toBe(false);
    expect(adapter.cliDialect.saveOrCommit).toEqual({ kind: 'none', commands: [] });
  });

  describe('buildCliPlan', () => {
    it('port.setAdminStatus up', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: 'port5', adminStatus: 'up' };
      expect(adapter.buildCliPlan(action)).toEqual([
        'config switch interface',
        'edit "port5"',
        'set status up',
        'next',
        'end',
      ]);
    });

    it('port.setAdminStatus down', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: 'port5', adminStatus: 'down' };
      expect(adapter.buildCliPlan(action)).toEqual([
        'config switch interface',
        'edit "port5"',
        'set status down',
        'next',
        'end',
      ]);
    });

    it('port.setDescription', () => {
      const action: DeviceAction = { kind: 'port.setDescription', interfaceName: 'port5', description: 'uplink-core1' };
      expect(adapter.buildCliPlan(action)).toEqual([
        'config switch interface',
        'edit "port5"',
        'set description "uplink-core1"',
        'next',
        'end',
      ]);
    });

    it('vlan.setPvid uses native-vlan', () => {
      const action: DeviceAction = { kind: 'vlan.setPvid', interfaceName: 'port5', vlanId: 10 };
      expect(adapter.buildCliPlan(action)).toEqual([
        'config switch interface',
        'edit "port5"',
        'set native-vlan 10',
        'next',
        'end',
      ]);
    });

    it('vlan.setTrunkAllowed uses allowed-vlans', () => {
      const action: DeviceAction = { kind: 'vlan.setTrunkAllowed', interfaceName: 'port5', vlanIds: [10, 20, 30] };
      expect(adapter.buildCliPlan(action)).toEqual([
        'config switch interface',
        'edit "port5"',
        'set allowed-vlans 10,20,30',
        'next',
        'end',
      ]);
    });

    it('vlan.create', () => {
      const action: DeviceAction = { kind: 'vlan.create', vlanId: 25, name: 'corporate_100' };
      expect(adapter.buildCliPlan(action)).toEqual([
        'config switch vlan',
        'edit 25',
        'set name "corporate_100"',
        'next',
        'end',
      ]);
    });

    it('config.save returns null — end already persists, nothing separate to send', () => {
      expect(adapter.buildCliPlan({ kind: 'config.save' })).toBeNull();
    });

    it('interface.setIpAddress returns null — no L3 CLI documented for this switch-scoped vendor', () => {
      const action: DeviceAction = {
        kind: 'interface.setIpAddress',
        interfaceName: 'port5',
        ipAddress: '10.0.0.1',
        prefixLength: 24,
      };
      expect(adapter.buildCliPlan(action)).toBeNull();
    });

    it('route.static.upsert returns null — no L3 CLI documented for this switch-scoped vendor', () => {
      const action: DeviceAction = {
        kind: 'route.static.upsert',
        destinationCidr: '192.168.100.0/24',
        nextHop: '10.0.0.254',
      };
      expect(adapter.buildCliPlan(action)).toBeNull();
    });
  });

  describe('buildSnmpPlan — CLI-only vendor, null throughout', () => {
    it('returns null for every action kind', () => {
      const actions: DeviceAction[] = [
        { kind: 'port.setAdminStatus', interfaceName: 'port5', adminStatus: 'up' },
        { kind: 'port.setDescription', interfaceName: 'port5', description: 'x' },
        { kind: 'vlan.setPvid', interfaceName: 'port5', vlanId: 10 },
        { kind: 'vlan.setTrunkAllowed', interfaceName: 'port5', vlanIds: [10] },
        { kind: 'vlan.create', vlanId: 10, name: 'x' },
        { kind: 'config.save' },
        { kind: 'interface.setIpAddress', interfaceName: 'port5', ipAddress: '10.0.0.1', prefixLength: 24 },
        { kind: 'route.static.upsert', destinationCidr: '10.0.0.0/24', nextHop: '10.0.0.1' },
      ];
      for (const action of actions) {
        expect(adapter.buildSnmpPlan(action)).toBeNull();
      }
    });
  });

  describe('buildReadbackCommand', () => {
    it('port.setAdminStatus / port.setDescription use get switch physical-port <name>', () => {
      expect(adapter.buildReadbackCommand({ kind: 'port.setAdminStatus', interfaceName: 'port5', adminStatus: 'up' })).toBe(
        'get switch physical-port port5',
      );
      expect(adapter.buildReadbackCommand({ kind: 'port.setDescription', interfaceName: 'port5', description: 'x' })).toBe(
        'get switch physical-port port5',
      );
    });

    it('vlan.setPvid / vlan.setTrunkAllowed / vlan.create use get switch vlan', () => {
      expect(adapter.buildReadbackCommand({ kind: 'vlan.setPvid', interfaceName: 'port5', vlanId: 10 })).toBe('get switch vlan');
      expect(adapter.buildReadbackCommand({ kind: 'vlan.setTrunkAllowed', interfaceName: 'port5', vlanIds: [10] })).toBe(
        'get switch vlan',
      );
      expect(adapter.buildReadbackCommand({ kind: 'vlan.create', vlanId: 10, name: 'x' })).toBe('get switch vlan');
    });

    it('config.save / interface.setIpAddress / route.static.upsert have no readback', () => {
      expect(adapter.buildReadbackCommand({ kind: 'config.save' })).toBeNull();
      expect(
        adapter.buildReadbackCommand({
          kind: 'interface.setIpAddress',
          interfaceName: 'port5',
          ipAddress: '10.0.0.1',
          prefixLength: 24,
        }),
      ).toBeNull();
      expect(
        adapter.buildReadbackCommand({ kind: 'route.static.upsert', destinationCidr: '10.0.0.0/24', nextHop: '10.0.0.1' }),
      ).toBeNull();
    });
  });

  describe('parseReadback', () => {
    it('parses admin status from get switch physical-port output', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: 'port5', adminStatus: 'up' };
      const raw = 'name: port5\r\nstatus: up\r\nspeed: 1000full';
      const diff = adapter.parseReadback(action, raw);
      expect(diff.changed).toBe(true);
      expect(diff.after).toEqual({ adminUp: true });
    });

    it('parses down status', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: 'port5', adminStatus: 'down' };
      const raw = 'name: port5\r\nstatus: down';
      const diff = adapter.parseReadback(action, raw);
      expect(diff.after).toEqual({ adminUp: false });
    });

    it('parses description from readback output', () => {
      const action: DeviceAction = { kind: 'port.setDescription', interfaceName: 'port5', description: 'uplink-core1' };
      const raw = 'name: port5\r\ndescription: "uplink-core1"\r\nstatus: up';
      const diff = adapter.parseReadback(action, raw);
      expect(diff.after).toBe('uplink-core1');
    });
  });
});
