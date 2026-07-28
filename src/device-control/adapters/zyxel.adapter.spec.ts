import { ZyxelAdapter } from './zyxel.adapter';
import { DeviceAction } from './vendor-adapter.interface';

describe('ZyxelAdapter', () => {
  const adapter = new ZyxelAdapter();

  it('has the expected profileId', () => {
    expect(adapter.profileId).toBe('zyxel');
  });

  it('has an IOS-adjacent cliDialect with the confirmed write memory save command', () => {
    expect(adapter.cliDialect.pagingDisableCmd).toBeNull();
    expect(adapter.cliDialect.enableSequence).toBeNull();
    expect(adapter.cliDialect.negationKeyword).toBeNull();
    expect(adapter.cliDialect.candidateConfig).toBe(false);
    expect(adapter.cliDialect.saveOrCommit).toEqual({ kind: 'persist', commands: ['write memory'] });
  });

  describe('buildCliPlan — most actions correctly return null (unconfirmed syntax)', () => {
    it('port.setAdminStatus returns null — enable/disable keyword unconfirmed', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: 'port1', adminStatus: 'up' };
      expect(adapter.buildCliPlan(action)).toBeNull();
    });

    it('port.setAdminStatus down also returns null', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: 'port1', adminStatus: 'down' };
      expect(adapter.buildCliPlan(action)).toBeNull();
    });

    it('port.setDescription returns null — not documented for this vendor', () => {
      const action: DeviceAction = { kind: 'port.setDescription', interfaceName: 'port1', description: 'uplink' };
      expect(adapter.buildCliPlan(action)).toBeNull();
    });

    it('vlan.setPvid returns null — only confirmed inside interface port-channel context, does not generalize', () => {
      const action: DeviceAction = { kind: 'vlan.setPvid', interfaceName: 'port1', vlanId: 10 };
      expect(adapter.buildCliPlan(action)).toBeNull();
    });

    it('vlan.setTrunkAllowed returns null', () => {
      const action: DeviceAction = { kind: 'vlan.setTrunkAllowed', interfaceName: 'port1', vlanIds: [10, 20] };
      expect(adapter.buildCliPlan(action)).toBeNull();
    });

    it('interface.setIpAddress returns null — no L3 CLI documented', () => {
      const action: DeviceAction = {
        kind: 'interface.setIpAddress',
        interfaceName: 'port1',
        ipAddress: '10.0.0.1',
        prefixLength: 24,
      };
      expect(adapter.buildCliPlan(action)).toBeNull();
    });

    it('route.static.upsert returns null — no L3 CLI documented', () => {
      const action: DeviceAction = { kind: 'route.static.upsert', destinationCidr: '10.0.0.0/24', nextHop: '10.0.0.1' };
      expect(adapter.buildCliPlan(action)).toBeNull();
    });
  });

  describe('buildCliPlan — the two genuinely confirmed actions', () => {
    it('vlan.create uses the confirmed configure / vlan <n> sequence', () => {
      const action: DeviceAction = { kind: 'vlan.create', vlanId: 25, name: 'corporate_100' };
      expect(adapter.buildCliPlan(action)).toEqual(['configure', 'vlan 25']);
    });

    it('config.save uses the confirmed write memory command', () => {
      const action: DeviceAction = { kind: 'config.save' };
      expect(adapter.buildCliPlan(action)).toEqual(['write memory']);
    });
  });

  describe('buildSnmpPlan — always null, SNMP write status is unresolved for this vendor', () => {
    const actions: DeviceAction[] = [
      { kind: 'port.setAdminStatus', interfaceName: 'port1', adminStatus: 'up' },
      { kind: 'port.setDescription', interfaceName: 'port1', description: 'x' },
      { kind: 'vlan.setPvid', interfaceName: 'port1', vlanId: 10 },
      { kind: 'vlan.setTrunkAllowed', interfaceName: 'port1', vlanIds: [10] },
      { kind: 'vlan.create', vlanId: 10, name: 'x' },
      { kind: 'config.save' },
      { kind: 'interface.setIpAddress', interfaceName: 'port1', ipAddress: '10.0.0.1', prefixLength: 24 },
      { kind: 'route.static.upsert', destinationCidr: '10.0.0.0/24', nextHop: '10.0.0.1' },
    ];

    it.each(actions)('%o returns null', (action) => {
      expect(adapter.buildSnmpPlan(action)).toBeNull();
    });
  });

  describe('buildReadbackCommand', () => {
    it('vlan.create uses show running-config — the one command confirmed to work even on GS1900', () => {
      expect(adapter.buildReadbackCommand({ kind: 'vlan.create', vlanId: 25, name: 'corporate_100' })).toBe(
        'show running-config',
      );
    });

    it('config.save has no readback', () => {
      expect(adapter.buildReadbackCommand({ kind: 'config.save' })).toBeNull();
    });

    it('port.setAdminStatus has no readback (no confirmed write path either)', () => {
      expect(adapter.buildReadbackCommand({ kind: 'port.setAdminStatus', interfaceName: 'port1', adminStatus: 'up' })).toBeNull();
    });
  });

  describe('parseReadback', () => {
    it('detects a created VLAN in running-config output', () => {
      const action: DeviceAction = { kind: 'vlan.create', vlanId: 25, name: 'corporate_100' };
      const raw = 'vlan database\r\nvlan 25\r\n interface port-channel 1\r\n  pvid 25\r\nexit';
      const diff = adapter.parseReadback(action, raw);
      expect(diff.changed).toBe(true);
      expect(diff.after).toEqual({ vlanId: 25 });
    });

    it('reports unchanged when the VLAN is absent from running-config output', () => {
      const action: DeviceAction = { kind: 'vlan.create', vlanId: 99, name: 'missing' };
      const raw = 'vlan database\r\nvlan 1\r\nexit';
      const diff = adapter.parseReadback(action, raw);
      expect(diff.changed).toBe(false);
    });
  });
});
