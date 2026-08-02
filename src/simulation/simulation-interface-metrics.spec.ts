import { createOuWalker, seedFromString } from './simulation.engine';
import { speedToMbps, isBackboneInterface } from './simulation.service';

// Covers the pure-logic pieces behind persistInterfaceMetrics()/persistWanMetrics()/
// persistFlowStats() — the fix for AUDIT-REPORT.md L1's interface_metrics/
// flow_stats/wan_metrics being schema-only tables nothing ever wrote to. The
// DB-writing side is verified separately by actually booting the app against
// a live database (see simulation.service.ts's inline comments); this spec
// is the fast, no-DB-required check that the math behind those writes is sane.

describe('speedToMbps', () => {
  it('parses gigabit speeds', () => {
    expect(speedToMbps('1G')).toBe(1000);
    expect(speedToMbps('10G')).toBe(10000);
    expect(speedToMbps('100G')).toBe(100000);
  });

  it('parses megabit speeds', () => {
    expect(speedToMbps('100M')).toBe(100);
  });

  it('is case-insensitive on the unit', () => {
    expect(speedToMbps('10g')).toBe(10000);
  });

  it('falls back to 1000 Mbps for null/unparseable input rather than 0 (which would make utilization divide-by-zero into always-100%)', () => {
    expect(speedToMbps(null)).toBe(1000);
    expect(speedToMbps('')).toBe(1000);
    expect(speedToMbps('unknown')).toBe(1000);
  });
});

describe('isBackboneInterface', () => {
  it('flags uplink/WAN/trunk-flavored interfaces from name or description', () => {
    expect(isBackboneInterface('Te1/1/49', 'ISP-B handoff')).toBe(true);
    expect(isBackboneInterface('et-0/0/0', 'ISP-A WAN handoff')).toBe(true);
    expect(isBackboneInterface('Gi0/5', 'trunk vlan100-300')).toBe(true);
    expect(isBackboneInterface('Ethernet5', 'WAN ISP-C')).toBe(true);
  });

  it('does not flag ordinary access ports', () => {
    expect(isBackboneInterface('Gi1/0/10', 'workstation-A39')).toBe(false);
    expect(isBackboneInterface('management', 'OOB management')).toBe(false);
  });
});

describe('createOuWalker', () => {
  it('is deterministic for a given seed', () => {
    const a = createOuWalker(seedFromString('x'), { base: 50, amp: 20 });
    const b = createOuWalker(seedFromString('x'), { base: 50, amp: 20 });
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('different seeds diverge', () => {
    const a = createOuWalker(seedFromString('x'), { base: 50, amp: 20 });
    const b = createOuWalker(seedFromString('y'), { base: 50, amp: 20 });
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it('respects min/max clamps', () => {
    const w = createOuWalker(seedFromString('clamp'), { base: 95, amp: 40, min: 0, max: 100 });
    for (let i = 0; i < 200; i++) {
      const v = w();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('settles near its base over many steps', () => {
    const w = createOuWalker(seedFromString('settle'), { base: 40, amp: 10, min: 0, max: 100 });
    let last = 40;
    for (let i = 0; i < 500; i++) last = w();
    expect(Math.abs(last - 40)).toBeLessThan(25);
  });

  it('shifts toward a new target when targetMultiplier changes', () => {
    const w = createOuWalker(seedFromString('shift'), { base: 20, amp: 2, min: 0, max: 200 });
    for (let i = 0; i < 50; i++) w(1); // settle near 20
    let last = 0;
    for (let i = 0; i < 300; i++) last = w(5); // target becomes 100
    expect(last).toBeGreaterThan(50);
  });
});

describe('seedFromString', () => {
  it('is stable for the same input', () => {
    expect(seedFromString('iface-util:42')).toBe(seedFromString('iface-util:42'));
  });

  it('differs for different input', () => {
    expect(seedFromString('iface-util:42')).not.toBe(seedFromString('iface-util:43'));
  });
});
