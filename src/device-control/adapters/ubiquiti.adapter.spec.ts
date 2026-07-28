import { UbiquitiAdapter } from './ubiquiti.adapter';
import { DeviceAction } from './vendor-adapter.interface';

describe('UbiquitiAdapter', () => {
  const adapter = new UbiquitiAdapter();

  it('has the expected profileId and interface naming pattern', () => {
    expect(adapter.profileId).toBe('ubiquiti');
    expect(adapter.interfaceNamePattern.test('0/1')).toBe(true);
    expect(adapter.interfaceNamePattern.test('1/24')).toBe(true);
    // Not FASTPATH-style — a Cisco-shaped name should not match.
    expect(adapter.interfaceNamePattern.test('GigabitEthernet0/1')).toBe(false);
  });

  it('has a controller-first cliDialect with no durable save and a nested-telnet enable sequence', () => {
    expect(adapter.cliDialect.pagingDisableCmd).toBeNull();
    expect(adapter.cliDialect.enableSequence).toEqual(['telnet 127.0.0.1', 'enable']);
    expect(adapter.cliDialect.negationKeyword).toBeNull();
    expect(adapter.cliDialect.candidateConfig).toBe(false);
    expect(adapter.cliDialect.saveOrCommit).toEqual({ kind: 'none', commands: [] });
  });

  describe('buildCliPlan', () => {
    it('port.setAdminStatus up (assumed IOS-adjacent keyword)', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: '0/1', adminStatus: 'up' };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure',
        'interface 0/1',
        'no shutdown',
        'exit',
      ]);
    });

    it('port.setAdminStatus down', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: '0/1', adminStatus: 'down' };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure',
        'interface 0/1',
        'shutdown',
        'exit',
      ]);
    });

    it('vlan.setPvid issues participation-include then pvid', () => {
      const action: DeviceAction = { kind: 'vlan.setPvid', interfaceName: '0/1', vlanId: 10 };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure',
        'interface 0/1',
        'vlan participation include 10',
        'vlan pvid 10',
        'exit',
      ]);
    });

    it('vlan.setTrunkAllowed issues participation-include then tagging, both comma-joined', () => {
      const action: DeviceAction = { kind: 'vlan.setTrunkAllowed', interfaceName: '0/1', vlanIds: [10, 20, 30] };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure',
        'interface 0/1',
        'vlan participation include 10,20,30',
        'vlan tagging 10,20,30',
        'exit',
      ]);
    });

    it('port.setDescription returns null — no description command documented for this vendor', () => {
      const action: DeviceAction = { kind: 'port.setDescription', interfaceName: '0/1', description: 'x' };
      expect(adapter.buildCliPlan(action)).toBeNull();
    });

    it('vlan.create returns null — no VLAN-creation command documented', () => {
      const action: DeviceAction = { kind: 'vlan.create', vlanId: 10, name: 'x' };
      expect(adapter.buildCliPlan(action)).toBeNull();
    });

    it('config.save returns null — controller is the only durable save target', () => {
      expect(adapter.buildCliPlan({ kind: 'config.save' })).toBeNull();
    });

    it('interface.setIpAddress returns null — not documented for this switch-focused vendor doc', () => {
      const action: DeviceAction = {
        kind: 'interface.setIpAddress',
        interfaceName: '0/1',
        ipAddress: '10.0.0.1',
        prefixLength: 24,
      };
      expect(adapter.buildCliPlan(action)).toBeNull();
    });

    it('route.static.upsert returns null — not documented', () => {
      const action: DeviceAction = { kind: 'route.static.upsert', destinationCidr: '10.0.0.0/24', nextHop: '10.0.0.1' };
      expect(adapter.buildCliPlan(action)).toBeNull();
    });
  });

  describe('buildSnmpPlan — confirmed zero read-write objects in UBNT-MIB.txt', () => {
    const actions: DeviceAction[] = [
      { kind: 'port.setAdminStatus', interfaceName: '0/1', adminStatus: 'up' },
      { kind: 'port.setDescription', interfaceName: '0/1', description: 'x' },
      { kind: 'vlan.setPvid', interfaceName: '0/1', vlanId: 10 },
      { kind: 'vlan.setTrunkAllowed', interfaceName: '0/1', vlanIds: [10] },
      { kind: 'vlan.create', vlanId: 10, name: 'x' },
      { kind: 'config.save' },
      { kind: 'interface.setIpAddress', interfaceName: '0/1', ipAddress: '10.0.0.1', prefixLength: 24 },
      { kind: 'route.static.upsert', destinationCidr: '10.0.0.0/24', nextHop: '10.0.0.1' },
    ];

    it.each(actions)('returns null for %j', (action) => {
      expect(adapter.buildSnmpPlan(action)).toBeNull();
    });
  });

  describe('buildReadbackCommand', () => {
    it('uses show running-config for actions with a real CLI plan', () => {
      expect(adapter.buildReadbackCommand({ kind: 'port.setAdminStatus', interfaceName: '0/1', adminStatus: 'up' })).toBe(
        'show running-config',
      );
      expect(adapter.buildReadbackCommand({ kind: 'vlan.setPvid', interfaceName: '0/1', vlanId: 10 })).toBe(
        'show running-config',
      );
      expect(adapter.buildReadbackCommand({ kind: 'vlan.setTrunkAllowed', interfaceName: '0/1', vlanIds: [10] })).toBe(
        'show running-config',
      );
    });

    it('returns null for actions with no CLI plan', () => {
      expect(adapter.buildReadbackCommand({ kind: 'config.save' })).toBeNull();
      expect(adapter.buildReadbackCommand({ kind: 'vlan.create', vlanId: 10, name: 'x' })).toBeNull();
    });
  });

  describe('parseReadback', () => {
    const runningConfig =
      'interface 0/1\r\n' +
      ' vlan participation include 10\r\n' +
      ' vlan pvid 10\r\n' +
      ' vlan tagging 20,30\r\n' +
      'interface 0/2\r\n' +
      ' shutdown\r\n';

    it('parses admin-up state (no shutdown line present in block)', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: '0/1', adminStatus: 'up' };
      const diff = adapter.parseReadback(action, runningConfig);
      expect(diff.after).toEqual({ adminUp: true });
    });

    it('parses admin-down state (shutdown line present in block)', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: '0/2', adminStatus: 'down' };
      const diff = adapter.parseReadback(action, runningConfig);
      expect(diff.after).toEqual({ adminUp: false });
    });

    it('parses pvid from running-config', () => {
      const action: DeviceAction = { kind: 'vlan.setPvid', interfaceName: '0/1', vlanId: 10 };
      const diff = adapter.parseReadback(action, runningConfig);
      expect(diff.after).toBe(10);
    });

    it('parses tagged VLAN list from running-config', () => {
      const action: DeviceAction = { kind: 'vlan.setTrunkAllowed', interfaceName: '0/1', vlanIds: [20, 30] };
      const diff = adapter.parseReadback(action, runningConfig);
      expect(diff.after).toEqual([20, 30]);
    });
  });
});
