import { JuniperJunosAdapter } from './juniper-junos.adapter';
import { DeviceAction } from './vendor-adapter.interface';

describe('JuniperJunosAdapter', () => {
  const adapter = new JuniperJunosAdapter();

  it('has the correct candidate-config dialect facts', () => {
    expect(adapter.cliDialect.candidateConfig).toBe(true);
    expect(adapter.cliDialect.enableSequence).toBeNull();
    expect(adapter.cliDialect.saveOrCommit).toEqual({ kind: 'commit', commands: ['commit'] });
    expect(adapter.cliDialect.pagingDisableCmd).toBe('set cli screen-length 0');
  });

  it('validates the ge-0/0/1 style interface naming pattern', () => {
    expect(adapter.interfaceNamePattern.test('ge-0/0/1')).toBe(true);
    expect(adapter.interfaceNamePattern.test('xe-0/1/2')).toBe(true);
    expect(adapter.interfaceNamePattern.test('GigabitEthernet0/1')).toBe(false);
  });

  describe('buildCliPlan', () => {
    it('port.setAdminStatus up deletes the disable statement (Junos has no positive enable)', () => {
      const plan = adapter.buildCliPlan({ kind: 'port.setAdminStatus', interfaceName: 'ge-0/0/1', adminStatus: 'up' });
      expect(plan).toEqual(['configure', 'delete interfaces ge-0/0/1 disable']);
    });

    it('port.setAdminStatus down sets the disable statement', () => {
      const plan = adapter.buildCliPlan({ kind: 'port.setAdminStatus', interfaceName: 'ge-0/0/1', adminStatus: 'down' });
      expect(plan).toEqual(['configure', 'set interfaces ge-0/0/1 disable']);
    });

    it('port.setDescription', () => {
      const plan = adapter.buildCliPlan({ kind: 'port.setDescription', interfaceName: 'ge-0/0/1', description: 'uplink' });
      expect(plan).toEqual(['configure', 'set interfaces ge-0/0/1 description "uplink"']);
    });

    it('vlan.setPvid sets access mode then vlan members', () => {
      const plan = adapter.buildCliPlan({ kind: 'vlan.setPvid', interfaceName: 'ge-0/0/1', vlanId: 10 });
      expect(plan).toEqual([
        'configure',
        'set interfaces ge-0/0/1 unit 0 family ethernet-switching interface-mode access',
        'set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members 10',
      ]);
    });

    it('vlan.setTrunkAllowed sets trunk mode then a bracketed vlan list', () => {
      const plan = adapter.buildCliPlan({ kind: 'vlan.setTrunkAllowed', interfaceName: 'ge-0/0/1', vlanIds: [10, 20, 30] });
      expect(plan).toEqual([
        'configure',
        'set interfaces ge-0/0/1 unit 0 family ethernet-switching interface-mode trunk',
        'set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members [ 10 20 30 ]',
      ]);
    });

    it('vlan.create maps directly to Junos named-VLAN syntax', () => {
      const plan = adapter.buildCliPlan({ kind: 'vlan.create', vlanId: 10, name: 'staff' });
      expect(plan).toEqual(['configure', 'set vlans staff vlan-id 10']);
    });

    it('config.save re-enters configure before commit (fresh-session architecture)', () => {
      const plan = adapter.buildCliPlan({ kind: 'config.save' });
      expect(plan).toEqual(['configure', 'commit']);
    });

    it('never includes commit in a non-save action plan', () => {
      const plan = adapter.buildCliPlan({ kind: 'port.setDescription', interfaceName: 'ge-0/0/1', description: 'x' })!;
      expect(plan).not.toContain('commit');
    });
  });

  describe('buildSnmpPlan', () => {
    it('returns null for port.setAdminStatus (explicitly documented as not SET-able on Junos)', () => {
      expect(adapter.buildSnmpPlan({ kind: 'port.setAdminStatus', interfaceName: 'ge-0/0/1', adminStatus: 'up' })).toBeNull();
    });

    const noSnmpActions: DeviceAction[] = [
      { kind: 'port.setDescription', interfaceName: 'ge-0/0/1', description: 'x' },
      { kind: 'vlan.setPvid', interfaceName: 'ge-0/0/1', vlanId: 10 },
      { kind: 'vlan.setTrunkAllowed', interfaceName: 'ge-0/0/1', vlanIds: [10] },
      { kind: 'vlan.create', vlanId: 10, name: 'staff' },
      { kind: 'config.save' },
    ];
    it.each(noSnmpActions)('returns null for $kind (no confirmed Junos SNMP write path)', (action) => {
      expect(adapter.buildSnmpPlan(action)).toBeNull();
    });
  });

  describe('buildReadbackCommand', () => {
    it('uses `run show interfaces terse` for admin status (config-mode passthrough, session never exits candidate mode)', () => {
      expect(adapter.buildReadbackCommand({ kind: 'port.setAdminStatus', interfaceName: 'ge-0/0/1', adminStatus: 'up' })).toBe(
        'run show interfaces ge-0/0/1 terse',
      );
    });

    it('returns null for config.save', () => {
      expect(adapter.buildReadbackCommand({ kind: 'config.save' })).toBeNull();
    });
  });

  describe('parseReadback', () => {
    it('extracts admin/oper state from show interfaces terse output', () => {
      const raw = 'ge-0/0/1.0             up    up   eth-switch\n';
      const diff = adapter.parseReadback({ kind: 'port.setAdminStatus', interfaceName: 'ge-0/0/1', adminStatus: 'up' }, raw);
      expect(diff.changed).toBe(true);
      expect((diff.after as any).adminUp).toBe(true);
    });

    it('extracts description text from configuration output', () => {
      const raw = 'ge-0/0/1 {\n    description "uplink";\n}\n';
      const diff = adapter.parseReadback({ kind: 'port.setDescription', interfaceName: 'ge-0/0/1', description: 'uplink' }, raw);
      expect(diff.after).toBe('uplink');
    });
  });
});
