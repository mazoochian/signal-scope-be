import { MikrotikRouterosAdapter } from './mikrotik-routeros.adapter';
import { DeviceAction, DeviceActionKind } from './vendor-adapter.interface';

/**
 * Plain Jest unit test, no live transport / no network. Two things matter
 * most for this vendor and are asserted explicitly:
 *
 * 1. buildCliPlan() returns a SINGLE fully-qualified menu-path line per
 *    action (not a Cisco-style multi-line mode-entry sequence), since
 *    RouterOS has no config-mode context to enter/exit — see
 *    mikrotik-routeros.adapter.ts's top-of-file comment and
 *    signal-scope-docs/vendors/mikrotik/overview.md.
 * 2. buildSnmpPlan() returns null for EVERY action kind in this phase's
 *    DeviceAction set — this is the single most important behavior to
 *    verify, since MikroTik's own vendored MIKROTIK-MIB.txt confirms only
 *    three read-write objects exist in the entire module, none of them a
 *    switch/router configuration object. A wrong implementation here would
 *    mean SignalScope attempts SNMP SETs that don't exist on this
 *    platform.
 */
describe('MikrotikRouterosAdapter', () => {
  const adapter = new MikrotikRouterosAdapter();

  const ACTIONS: DeviceAction[] = [
    { kind: 'port.setAdminStatus', interfaceName: 'ether1', adminStatus: 'down' },
    { kind: 'port.setAdminStatus', interfaceName: 'ether1', adminStatus: 'up' },
    { kind: 'port.setDescription', interfaceName: 'ether1', description: 'uplink to core-sw1' },
    { kind: 'vlan.setPvid', interfaceName: 'ether2', vlanId: 20 },
    { kind: 'vlan.setTrunkAllowed', interfaceName: 'ether1', vlanIds: [10, 20, 30] },
    { kind: 'vlan.create', vlanId: 20, name: 'staff' },
    { kind: 'config.save' },
    { kind: 'interface.setIpAddress', interfaceName: 'ether1', ipAddress: '10.0.0.1', prefixLength: 24 },
    { kind: 'route.static.upsert', destinationCidr: '192.168.100.0/24', nextHop: '10.0.0.254' },
  ];

  describe('cliDialect — no mode-based config concepts', () => {
    it('has no enable step', () => {
      expect(adapter.cliDialect.enableSequence).toBeNull();
    });
    it('has no negation particle', () => {
      expect(adapter.cliDialect.negationKeyword).toBeNull();
    });
    it('has no paging to disable', () => {
      expect(adapter.cliDialect.pagingDisableCmd).toBeNull();
    });
    it('has no save/commit step', () => {
      expect(adapter.cliDialect.saveOrCommit).toEqual({ kind: 'none', commands: [] });
    });
    it('does not use a candidate-config model', () => {
      expect(adapter.cliDialect.candidateConfig).toBe(false);
    });
  });

  describe('interfaceNamePattern — permissive free-text, not positional', () => {
    it('accepts factory-default names', () => {
      expect(adapter.interfaceNamePattern.test('ether1')).toBe(true);
    });
    it('accepts user-renamed names', () => {
      expect(adapter.interfaceNamePattern.test('uplink-core1')).toBe(true);
      expect(adapter.interfaceNamePattern.test('uplink_core1')).toBe(true);
    });
    it('rejects a Cisco-style positional name (spaces/slash not part of a free-text token)', () => {
      expect(adapter.interfaceNamePattern.test('Gigabit Ethernet 0/1')).toBe(false);
    });
  });

  describe('buildCliPlan — single fully-qualified line per action, no mode-entry sequence', () => {
    it('port.setAdminStatus down → single disable line', () => {
      const plan = adapter.buildCliPlan({ kind: 'port.setAdminStatus', interfaceName: 'ether1', adminStatus: 'down' });
      expect(plan).toEqual(['/interface disable ether1']);
    });

    it('port.setAdminStatus up → single enable line', () => {
      const plan = adapter.buildCliPlan({ kind: 'port.setAdminStatus', interfaceName: 'ether1', adminStatus: 'up' });
      expect(plan).toEqual(['/interface enable ether1']);
    });

    it('port.setDescription → single set line with comment=', () => {
      const plan = adapter.buildCliPlan({ kind: 'port.setDescription', interfaceName: 'ether1', description: 'uplink to core-sw1' });
      expect(plan).toEqual(['/interface set ether1 comment="uplink to core-sw1"']);
    });

    it('vlan.setPvid → single bridge port set line using [find ...]', () => {
      const plan = adapter.buildCliPlan({ kind: 'vlan.setPvid', interfaceName: 'ether2', vlanId: 20 });
      expect(plan).toEqual(['/interface bridge port set [find interface=ether2] pvid=20']);
    });

    it('vlan.setTrunkAllowed → single bridge vlan add line with combined vlan-ids', () => {
      const plan = adapter.buildCliPlan({ kind: 'vlan.setTrunkAllowed', interfaceName: 'ether1', vlanIds: [10, 20, 30] });
      expect(plan).toEqual(['/interface bridge vlan add bridge=bridge1 tagged=ether1 vlan-ids=10,20,30']);
    });

    it('vlan.create → single bridge vlan add line', () => {
      const plan = adapter.buildCliPlan({ kind: 'vlan.create', vlanId: 20, name: 'staff' });
      expect(plan).toEqual(['/interface bridge vlan add bridge=bridge1 vlan-ids=20 comment="staff"']);
    });

    it('config.save → empty plan, not null (a plan exists, it is just zero commands)', () => {
      const plan = adapter.buildCliPlan({ kind: 'config.save' });
      expect(plan).toEqual([]);
      expect(plan).not.toBeNull();
    });

    it('interface.setIpAddress → single ip address add line', () => {
      const plan = adapter.buildCliPlan({ kind: 'interface.setIpAddress', interfaceName: 'ether1', ipAddress: '10.0.0.1', prefixLength: 24 });
      expect(plan).toEqual(['/ip address add address=10.0.0.1/24 interface=ether1']);
    });

    it('route.static.upsert → single ip route add line', () => {
      const plan = adapter.buildCliPlan({ kind: 'route.static.upsert', destinationCidr: '192.168.100.0/24', nextHop: '10.0.0.254' });
      expect(plan).toEqual(['/ip route add dst-address=192.168.100.0/24 gateway=10.0.0.254']);
    });

    it('every non-null plan is exactly one line — no Cisco-style mode-entry sequence anywhere', () => {
      for (const action of ACTIONS) {
        const plan = adapter.buildCliPlan(action);
        if (plan === null) continue;
        expect(plan.length).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('buildSnmpPlan — null for every action kind, no exceptions', () => {
    it.each(ACTIONS)('returns null for $kind', (action) => {
      expect(adapter.buildSnmpPlan(action)).toBeNull();
    });

    it('covers every DeviceActionKind the interface declares', () => {
      const coveredKinds: DeviceActionKind[] = ACTIONS.map((a) => a.kind);
      const expectedKinds: DeviceActionKind[] = [
        'port.setAdminStatus',
        'port.setDescription',
        'vlan.setPvid',
        'vlan.setTrunkAllowed',
        'vlan.create',
        'config.save',
        'interface.setIpAddress',
        'route.static.upsert',
      ];
      for (const kind of expectedKinds) {
        expect(coveredKinds).toContain(kind);
      }
    });
  });

  describe('buildReadbackCommand', () => {
    it('uses /interface print detail where name= for port actions', () => {
      expect(adapter.buildReadbackCommand({ kind: 'port.setAdminStatus', interfaceName: 'ether1', adminStatus: 'up' })).toBe(
        '/interface print detail where name=ether1',
      );
    });

    it('returns null for config.save (nothing to read back)', () => {
      expect(adapter.buildReadbackCommand({ kind: 'config.save' })).toBeNull();
    });
  });

  describe('parseReadback', () => {
    it('parses admin-up from a non-disabled interface print block', () => {
      const raw = ' 0  R name="ether1" default-name="ether1" type="ether" mtu=1500 disabled=no running=yes';
      const diff = adapter.parseReadback({ kind: 'port.setAdminStatus', interfaceName: 'ether1', adminStatus: 'up' }, raw);
      expect(diff.after).toEqual({ adminUp: true });
    });

    it('parses admin-down from a disabled interface print block', () => {
      const raw = ' 0  X name="ether1" default-name="ether1" type="ether" mtu=1500 disabled=yes running=no';
      const diff = adapter.parseReadback({ kind: 'port.setAdminStatus', interfaceName: 'ether1', adminStatus: 'down' }, raw);
      expect(diff.after).toEqual({ adminUp: false });
    });

    it('parses the comment field for port.setDescription', () => {
      const raw = ' 0  R name="ether1" comment="uplink to core-sw1" mtu=1500';
      const diff = adapter.parseReadback({ kind: 'port.setDescription', interfaceName: 'ether1', description: 'uplink to core-sw1' }, raw);
      expect(diff.after).toBe('uplink to core-sw1');
    });
  });
});
