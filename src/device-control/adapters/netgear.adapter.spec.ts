import { NetgearAdapter } from './netgear.adapter';
import { DeviceAction } from './vendor-adapter.interface';

describe('NetgearAdapter', () => {
  const adapter = new NetgearAdapter();

  it('has the expected profileId and interface naming pattern', () => {
    expect(adapter.profileId).toBe('netgear');
    expect(adapter.interfaceNamePattern.test('1/0/1')).toBe(true);
    expect(adapter.interfaceNamePattern.test('GigabitEthernet0/1')).toBe(false);
    expect(adapter.interfaceNamePattern.test('Ethernet1')).toBe(false);
  });

  it('has an IOS-adjacent cliDialect with the confirmed Netgear save command', () => {
    expect(adapter.cliDialect.pagingDisableCmd).toBeNull();
    expect(adapter.cliDialect.enableSequence).toEqual(['enable']);
    expect(adapter.cliDialect.negationKeyword).toBe('no');
    expect(adapter.cliDialect.candidateConfig).toBe(false);
    expect(adapter.cliDialect.saveOrCommit).toEqual({
      kind: 'persist',
      commands: ['copy system:running-config nvram:startup-config'],
    });
  });

  describe('buildCliPlan', () => {
    it('port.setAdminStatus up', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: '1/0/1', adminStatus: 'up' };
      expect(adapter.buildCliPlan(action)).toEqual(['configure', 'interface 1/0/1', 'no shutdown', 'exit']);
    });

    it('port.setAdminStatus down', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: '1/0/1', adminStatus: 'down' };
      expect(adapter.buildCliPlan(action)).toEqual(['configure', 'interface 1/0/1', 'shutdown', 'exit']);
    });

    it('port.setDescription', () => {
      const action: DeviceAction = { kind: 'port.setDescription', interfaceName: '1/0/1', description: 'uplink' };
      expect(adapter.buildCliPlan(action)).toEqual(['configure', 'interface 1/0/1', 'description uplink', 'exit']);
    });

    it('config.save', () => {
      expect(adapter.buildCliPlan({ kind: 'config.save' })).toEqual([
        'copy system:running-config nvram:startup-config',
      ]);
    });

    it('vlan.setPvid returns null — command family unconfirmed-by-analogy for Netgear', () => {
      expect(adapter.buildCliPlan({ kind: 'vlan.setPvid', interfaceName: '1/0/1', vlanId: 10 })).toBeNull();
    });

    it('vlan.setTrunkAllowed returns null', () => {
      expect(
        adapter.buildCliPlan({ kind: 'vlan.setTrunkAllowed', interfaceName: '1/0/1', vlanIds: [10, 20] }),
      ).toBeNull();
    });

    it('vlan.create returns null', () => {
      expect(adapter.buildCliPlan({ kind: 'vlan.create', vlanId: 10, name: 'test' })).toBeNull();
    });

    it('interface.setIpAddress returns null — no documented L3 syntax', () => {
      expect(
        adapter.buildCliPlan({
          kind: 'interface.setIpAddress',
          interfaceName: '1/0/1',
          ipAddress: '10.0.0.1',
          prefixLength: 24,
        }),
      ).toBeNull();
    });

    it('route.static.upsert returns null', () => {
      expect(
        adapter.buildCliPlan({ kind: 'route.static.upsert', destinationCidr: '10.0.0.0/24', nextHop: '10.0.0.1' }),
      ).toBeNull();
    });
  });

  describe('buildSnmpPlan — no confirmed Netgear-specific write path for anything', () => {
    const actions: DeviceAction[] = [
      { kind: 'port.setAdminStatus', interfaceName: '1/0/1', adminStatus: 'up' },
      { kind: 'port.setDescription', interfaceName: '1/0/1', description: 'x' },
      { kind: 'vlan.setPvid', interfaceName: '1/0/1', vlanId: 10 },
      { kind: 'vlan.setTrunkAllowed', interfaceName: '1/0/1', vlanIds: [10] },
      { kind: 'vlan.create', vlanId: 10, name: 'x' },
      { kind: 'config.save' },
      { kind: 'interface.setIpAddress', interfaceName: '1/0/1', ipAddress: '10.0.0.1', prefixLength: 24 },
      { kind: 'route.static.upsert', destinationCidr: '10.0.0.0/24', nextHop: '10.0.0.1' },
    ];

    it.each(actions.map((a) => [a.kind, a] as const))('%s returns null', (_kind, action) => {
      expect(adapter.buildSnmpPlan(action)).toBeNull();
    });
  });

  describe('buildReadbackCommand', () => {
    it('port.setAdminStatus / port.setDescription use show interface <name>', () => {
      expect(
        adapter.buildReadbackCommand({ kind: 'port.setAdminStatus', interfaceName: '1/0/1', adminStatus: 'up' }),
      ).toBe('show interface 1/0/1');
      expect(
        adapter.buildReadbackCommand({ kind: 'port.setDescription', interfaceName: '1/0/1', description: 'x' }),
      ).toBe('show interface 1/0/1');
    });

    it('config.save has no readback', () => {
      expect(adapter.buildReadbackCommand({ kind: 'config.save' })).toBeNull();
    });

    it('vlan.setPvid has no readback since no CLI plan exists for it', () => {
      expect(adapter.buildReadbackCommand({ kind: 'vlan.setPvid', interfaceName: '1/0/1', vlanId: 10 })).toBeNull();
    });
  });

  describe('parseReadback', () => {
    it('parses admin-up state from readback output', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: '1/0/1', adminStatus: 'up' };
      const diff = adapter.parseReadback(action, 'Interface 1/0/1\r\nPort Status: Up\r\nAdmin Mode: Enable');
      expect(diff.changed).toBe(true);
      expect(diff.after).toEqual({ adminUp: true });
    });

    it('parses administratively down state', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: '1/0/1', adminStatus: 'down' };
      const diff = adapter.parseReadback(action, 'Interface 1/0/1 is administratively down');
      expect(diff.after).toEqual({ adminUp: false });
    });

    it('parses description from readback output', () => {
      const action: DeviceAction = { kind: 'port.setDescription', interfaceName: '1/0/1', description: 'uplink' };
      const diff = adapter.parseReadback(action, 'Interface 1/0/1\r\nDescription: uplink\r\nPort Status: Up');
      expect(diff.after).toBe('uplink');
    });
  });
});
