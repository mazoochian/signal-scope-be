import { ArubaAosCxAdapter } from './aruba-aoscx.adapter';
import { DeviceAction } from './vendor-adapter.interface';

describe('ArubaAosCxAdapter', () => {
  const adapter = new ArubaAosCxAdapter();

  it('has the expected profileId and interface naming pattern', () => {
    expect(adapter.profileId).toBe('aruba-aoscx');
    expect(adapter.interfaceNamePattern.test('1/1/1')).toBe(true);
    expect(adapter.interfaceNamePattern.test('1/1/48')).toBe(true);
    expect(adapter.interfaceNamePattern.test('GigabitEthernet0/1')).toBe(false);
  });

  it('has an IOS-shaped cliDialect with AOS-CX-specific paging command', () => {
    expect(adapter.cliDialect.pagingDisableCmd).toBe('no page');
    expect(adapter.cliDialect.enableSequence).toEqual(['enable']);
    expect(adapter.cliDialect.negationKeyword).toBe('no');
    expect(adapter.cliDialect.candidateConfig).toBe(false);
    expect(adapter.cliDialect.saveOrCommit).toEqual({ kind: 'persist', commands: ['copy running-config startup-config'] });
  });

  describe('buildCliPlan', () => {
    it('port.setAdminStatus up', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: '1/1/1', adminStatus: 'up' };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure terminal',
        'interface 1/1/1',
        'no shutdown',
        'end',
      ]);
    });

    it('port.setAdminStatus down', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: '1/1/1', adminStatus: 'down' };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure terminal',
        'interface 1/1/1',
        'shutdown',
        'end',
      ]);
    });

    it('port.setDescription', () => {
      const action: DeviceAction = { kind: 'port.setDescription', interfaceName: '1/1/1', description: 'uplink-core1' };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure terminal',
        'interface 1/1/1',
        'description uplink-core1',
        'end',
      ]);
    });

    it('vlan.setPvid collapses access-mode + PVID into one command, unlike Cisco', () => {
      const action: DeviceAction = { kind: 'vlan.setPvid', interfaceName: '1/1/1', vlanId: 10 };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure terminal',
        'interface 1/1/1',
        'vlan access 10',
        'end',
      ]);
    });

    it('vlan.setTrunkAllowed', () => {
      const action: DeviceAction = { kind: 'vlan.setTrunkAllowed', interfaceName: '1/1/1', vlanIds: [10, 20, 30] };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure terminal',
        'interface 1/1/1',
        'vlan trunk allowed 10,20,30',
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

    it('interface.setIpAddress uses CIDR-form address, unlike Cisco netmask form', () => {
      const action: DeviceAction = {
        kind: 'interface.setIpAddress',
        interfaceName: '1/1/1',
        ipAddress: '10.0.0.1',
        prefixLength: 24,
      };
      expect(adapter.buildCliPlan(action)).toEqual([
        'configure terminal',
        'interface 1/1/1',
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

  describe('buildSnmpPlan — the broadest confirmed write surface of the 9 new vendors', () => {
    it('port.setAdminStatus returns the standard IF-MIB::ifAdminStatus SET', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: '1/1/1', adminStatus: 'up' };
      expect(adapter.buildSnmpPlan(action)).toEqual([
        {
          oid: '1.3.6.1.2.1.2.2.1.7.<ifIndex>',
          type: 'Integer',
          value: 1,
          description: 'IF-MIB::ifAdminStatus.<ifIndex> = up(1)',
        },
      ]);
    });

    it('port.setDescription returns the standard IF-MIB::ifAlias SET', () => {
      const action: DeviceAction = { kind: 'port.setDescription', interfaceName: '1/1/1', description: 'uplink-core1' };
      const plan = adapter.buildSnmpPlan(action);
      expect(plan).toHaveLength(1);
      expect(plan?.[0].oid).toBe('1.3.6.1.2.1.31.1.1.1.18.<ifIndex>');
      expect(plan?.[0].value).toBe('uplink-core1');
    });

    it('vlan.setPvid returns a real Q-BRIDGE-MIB::dot1qPvid SET — confirmed writable on AOS-CX, unlike most vendors', () => {
      const action: DeviceAction = { kind: 'vlan.setPvid', interfaceName: '1/1/1', vlanId: 10 };
      const plan = adapter.buildSnmpPlan(action);
      expect(plan).toHaveLength(1);
      expect(plan?.[0]).toMatchObject({
        oid: '1.3.6.1.2.1.17.7.1.4.5.1.1.<ifIndex>',
        type: 'Integer',
        value: 10,
      });
    });

    it('vlan.setTrunkAllowed returns a real op per VLAN — the only vendor in this project with a confirmed trunk-allowed-list SNMP path', () => {
      const action: DeviceAction = { kind: 'vlan.setTrunkAllowed', interfaceName: '1/1/1', vlanIds: [10, 20] };
      const plan = adapter.buildSnmpPlan(action);
      expect(plan).toHaveLength(2);
      expect(plan?.[0].oid).toBe('1.3.6.1.2.1.17.7.1.4.3.1.2.10');
      expect(plan?.[1].oid).toBe('1.3.6.1.2.1.17.7.1.4.3.1.2.20');
    });

    it('vlan.create returns real RowStatus createAndGo ops', () => {
      const action: DeviceAction = { kind: 'vlan.create', vlanId: 10, name: 'test' };
      const plan = adapter.buildSnmpPlan(action);
      expect(plan).toHaveLength(2);
      expect(plan).toContainEqual(
        expect.objectContaining({ oid: '1.3.6.1.2.1.17.7.1.4.3.1.5.10', type: 'RowStatus', value: 4 }),
      );
      expect(plan).toContainEqual(
        expect.objectContaining({ oid: '1.3.6.1.2.1.17.7.1.4.3.1.1.10', value: 'test' }),
      );
    });

    it('config.save returns real ARUBAWIRED-CONFIG-MIB ops — confirmed writable, same RowStatus shape as Cisco', () => {
      const action: DeviceAction = { kind: 'config.save' };
      const plan = adapter.buildSnmpPlan(action);
      expect(plan).not.toBeNull();
      expect(plan?.length).toBeGreaterThan(0);
      expect(plan?.every((op) => op.oid.startsWith('1.3.6.1.4.1.47196.4.1.1.3.20'))).toBe(true);
    });

    it('interface.setIpAddress returns null — no documented SNMP path', () => {
      const action: DeviceAction = {
        kind: 'interface.setIpAddress',
        interfaceName: '1/1/1',
        ipAddress: '10.0.0.1',
        prefixLength: 24,
      };
      expect(adapter.buildSnmpPlan(action)).toBeNull();
    });

    it('route.static.upsert returns null — no documented SNMP path', () => {
      const action: DeviceAction = { kind: 'route.static.upsert', destinationCidr: '192.168.100.0/24', nextHop: '10.0.0.254' };
      expect(adapter.buildSnmpPlan(action)).toBeNull();
    });
  });

  describe('buildReadbackCommand', () => {
    it('port/vlan/IP actions use show interface <name>', () => {
      expect(adapter.buildReadbackCommand({ kind: 'port.setAdminStatus', interfaceName: '1/1/1', adminStatus: 'up' })).toBe(
        'show interface 1/1/1',
      );
      expect(adapter.buildReadbackCommand({ kind: 'vlan.setPvid', interfaceName: '1/1/1', vlanId: 10 })).toBe(
        'show interface 1/1/1',
      );
    });

    it('vlan.create uses show vlan', () => {
      expect(adapter.buildReadbackCommand({ kind: 'vlan.create', vlanId: 10, name: 'x' })).toBe('show vlan');
    });

    it('config.save has no readback', () => {
      expect(adapter.buildReadbackCommand({ kind: 'config.save' })).toBeNull();
    });
  });

  describe('parseReadback', () => {
    it('parses admin/oper status from AOS-CX show interface output', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: '1/1/1', adminStatus: 'up' };
      const raw = '1/1/1 is up, line protocol is up (connected)\r\n  Description: \r\n  Hardware is Ethernet';
      const diff = adapter.parseReadback(action, raw);
      expect(diff.changed).toBe(true);
      expect(diff.after).toEqual({ adminUp: true, operUp: true });
    });

    it('parses administratively down state', () => {
      const action: DeviceAction = { kind: 'port.setAdminStatus', interfaceName: '1/1/1', adminStatus: 'down' };
      const raw = '1/1/1 is administratively down, line protocol is down (notconnect)';
      const diff = adapter.parseReadback(action, raw);
      expect(diff.after).toEqual({ adminUp: false, operUp: false });
    });

    it('parses description from readback output', () => {
      const action: DeviceAction = { kind: 'port.setDescription', interfaceName: '1/1/1', description: 'uplink-core1' };
      const raw = '1/1/1 is up, line protocol is up (connected)\r\n  Description: uplink-core1\r\n  Hardware is Ethernet';
      const diff = adapter.parseReadback(action, raw);
      expect(diff.after).toBe('uplink-core1');
    });
  });
});
