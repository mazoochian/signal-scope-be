import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { SimulationEngine, createOuWalker, seedFromString } from './simulation.engine';
import { AlertEvaluator } from './alert-evaluator';

// Write a batch of device metrics to the DB every N ticks.
// At 2 s/tick this gives one DB write per 10 s instead of per 2 s.
const WRITE_EVERY_N_TICKS = 5;

/** Rough Mbps capacity by the free-text `speed` values seeded in the interfaces table ('10G', '1G', '100G', ...). Unrecognized/blank values fall back to 1G — better than treating them as 0-capacity (which would make utilization_pct divide-by-zero into always-100%). */
export function speedToMbps(speed: string | null): number {
  if (!speed) return 1000;
  const m = /^(\d+(?:\.\d+)?)\s*([GgMm])/.exec(speed.trim());
  if (!m) return 1000;
  const n = parseFloat(m[1]);
  return m[2].toLowerCase() === 'g' ? n * 1000 : n;
}

/** 'uplink'/'wan'/'trunk'-flavored interfaces run hotter and more volatile than access ports — matches how the rest of the seed data (descriptions, vlan='wan-*') already characterizes them, so the simulated numbers stay consistent with what an operator reading the description would expect. */
export function isBackboneInterface(name: string, description: string | null): boolean {
  const s = `${name} ${description ?? ''}`.toLowerCase();
  return /uplink|wan|trunk|peer-link|isp|backbone|core|spine/.test(s);
}

interface InterfaceSimState {
  deviceName: string;
  speedMbps: number;
  isDown: boolean;
  utilWalker: (targetMultiplier?: number) => number;
  errWalker: (targetMultiplier?: number) => number;
}

interface FlowSimState {
  flowsWalker: (targetMultiplier?: number) => number;
  convWalker: (targetMultiplier?: number) => number;
  dropWalker: (targetMultiplier?: number) => number;
}

@Injectable()
export class SimulationService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SimulationService.name);
  private readonly engine = new SimulationEngine();
  private alertEvaluator: AlertEvaluator;
  private timer: NodeJS.Timeout;
  private tickCount = 0;
  private deviceIdCache: Map<string, number> | null = null;
  private interfaceState: Map<number, InterfaceSimState> | null = null;
  private readonly flowState: FlowSimState = {
    flowsWalker: createOuWalker(seedFromString('flow:flows'), { base: 4200, amp: 900, min: 0 }),
    convWalker:  createOuWalker(seedFromString('flow:conversations'), { base: 18000, amp: 3500, min: 0 }),
    dropWalker:  createOuWalker(seedFromString('flow:drop'), { base: 0.02, amp: 0.03, min: 0, max: 5 }),
  };

  constructor(private readonly db: DbService) {
    this.alertEvaluator = new AlertEvaluator(db);
  }

  setAlertNotifier(fn: (alert: { id: string; severity: string; title: string; device: string; fired_at: Date }) => void) {
    this.alertEvaluator = new AlertEvaluator(this.db, fn);
  }

  onModuleInit() {
    this.timer = setInterval(() => this.onTick(), 2000);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  private async onTick() {
    this.engine.tick();
    this.tickCount++;

    if (this.tickCount % WRITE_EVERY_N_TICKS === 0) {
      await this.persistMetrics().catch((err: Error) =>
        this.log.warn(`device_metrics write failed: ${err.message}`),
      );
      await this.persistInterfaceMetrics().catch((err: Error) =>
        this.log.warn(`interface_metrics write failed: ${err.message}`),
      );
      await this.persistWanMetrics().catch((err: Error) =>
        this.log.warn(`wan_metrics write failed: ${err.message}`),
      );
      await this.persistFlowStats().catch((err: Error) =>
        this.log.warn(`flow_stats write failed: ${err.message}`),
      );
      await this.alertEvaluator.evaluate(this.engine.getSnapshot()).catch((err: Error) =>
        this.log.warn(`alert evaluation failed: ${err.message}`),
      );
    }
  }

  private async persistMetrics() {
    if (!this.deviceIdCache) {
      this.deviceIdCache = await this.loadDeviceIds();
    }

    const snapshot = this.engine.getSnapshot();
    if (!snapshot.length) return;

    const now = new Date();
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let idx = 1;

    for (const d of snapshot) {
      const dbId = this.deviceIdCache.get(d.id);
      if (!dbId) continue;
      placeholders.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
      values.push(
        now, dbId,
        d.cpu.toFixed(2), d.mem.toFixed(2),
        d.ingressGbps.toFixed(4), d.egressGbps.toFixed(4),
        d.latencyMs.toFixed(3), d.packetLossPct.toFixed(5),
      );
    }

    if (!placeholders.length) return;

    await this.db.query(
      `INSERT INTO device_metrics
         (time, device_id, cpu_pct, mem_pct, ingress_gbps, egress_gbps, latency_ms, packet_loss_pct)
       VALUES ${placeholders.join(',')}`,
      values,
    );
  }

  private async loadDeviceIds(): Promise<Map<string, number>> {
    const { rows } = await this.db.query<{ id: number; name: string }>(
      'SELECT id, name FROM devices',
    );
    return new Map(rows.map((r) => [r.name, r.id]));
  }

  /**
   * interface_metrics was schema-defined from day one (see
   * signal-scope-db migration 003) but nothing ever wrote to it — every
   * consumer (interfaces.service.ts, reports.service.ts's
   * interface-utilization report, sla.service.ts) either fell back to
   * hardcoded numbers or silently queried an empty table
   * (AUDIT-REPORT.md L1). This mirrors persistMetrics()'s device-level
   * approach: one seeded OU walker per interface (utilization) plus a
   * second, calmer one for error counts, gated by the interface's own
   * seeded `status` so a down/admin-down port always reports zero rather
   * than drifting like a live one.
   */
  private async loadInterfaceState(): Promise<Map<number, InterfaceSimState>> {
    const { rows } = await this.db.query<{
      id: number; device_id: number; device_name: string;
      name: string; description: string | null; speed: string | null; status: string;
    }>(`
      SELECT i.id, i.device_id, d.name AS device_name, i.name, i.description, i.speed, i.status
      FROM interfaces i JOIN devices d ON d.id = i.device_id
    `);

    const state = new Map<number, InterfaceSimState>();
    for (const r of rows) {
      const speedMbps = speedToMbps(r.speed);
      const backbone = isBackboneInterface(r.name, r.description);
      const baseUtilPct = backbone ? 45 : 12;
      const ampUtilPct = backbone ? 28 : 10;
      state.set(r.id, {
        deviceName: r.device_name,
        speedMbps,
        isDown: r.status === 'down',
        utilWalker: createOuWalker(seedFromString(`iface-util:${r.id}`), {
          base: baseUtilPct, amp: ampUtilPct, min: 0, max: 100,
        }),
        // Errors are rare in steady state; 'warn' interfaces run a visibly
        // higher error baseline so the report/detail views have something
        // real to distinguish them by.
        errWalker: createOuWalker(seedFromString(`iface-err:${r.id}`), {
          base: r.status === 'warn' ? 1.2 : 0.05, amp: r.status === 'warn' ? 2 : 0.3, min: 0, max: 50,
        }),
      });
    }
    return state;
  }

  private async persistInterfaceMetrics() {
    if (!this.interfaceState) {
      this.interfaceState = await this.loadInterfaceState();
    }
    if (!this.interfaceState.size) return;

    const now = new Date();
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let idx = 1;

    for (const [ifaceId, st] of this.interfaceState) {
      const utilPct = st.isDown ? 0 : +st.utilWalker().toFixed(2);
      // Split total utilized capacity unevenly between in/out (real links
      // are rarely symmetric) using a stable per-interface ratio derived
      // from its own id rather than a fresh random draw every tick.
      const inShare = st.isDown ? 0 : 0.35 + (ifaceId % 7) * 0.04; // 0.35–0.59
      const utilizedMbps = (utilPct / 100) * st.speedMbps;
      const inMbps  = +(utilizedMbps * inShare).toFixed(2);
      const outMbps = +(utilizedMbps * (1 - inShare)).toFixed(2);
      const errorCount = st.isDown ? 0 : Math.round(st.errWalker());

      placeholders.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
      values.push(now, ifaceId, inMbps, outMbps, utilPct, errorCount);
    }

    await this.db.query(
      `INSERT INTO interface_metrics (time, interface_id, in_mbps, out_mbps, utilization_pct, error_count)
       VALUES ${placeholders.join(',')}`,
      values,
    );
  }

  /** wan_metrics: same aggregate the live dashboard WAN chart already computes in-memory (getWanCurrent()) — this just also persists it, so reports.service.ts's interface-utilization-adjacent WAN reporting has real history instead of an empty table. */
  private async persistWanMetrics() {
    const wan = this.engine.getWanCurrent();
    await this.db.query(
      `INSERT INTO wan_metrics (time, ingress_gbps, egress_gbps, packet_loss_pct, latency_ms)
       VALUES (now(), $1, $2, $3, $4)`,
      [wan.ingressGbps, wan.egressGbps, wan.packetLossPct, wan.latencyMs],
    );
  }

  /** flow_stats has no device/interface FK — it's a single global NetFlow-style aggregate row. Scaled loosely off total simulated ingress so it rises and falls with overall traffic rather than being fully decoupled from the rest of the simulation. */
  private async persistFlowStats() {
    const totalIngressGbps = this.engine.getTotalIngressGbps();
    const trafficFactor = Math.max(0.2, totalIngressGbps / 40); // ~40 Gbps is a typical aggregate baseline across the seed fleet

    const flowsPerSec = Math.max(0, Math.round(this.flowState.flowsWalker(trafficFactor)));
    const activeConversations = Math.max(0, Math.round(this.flowState.convWalker(trafficFactor)));
    const bytesPerSec = Math.round((totalIngressGbps * 1e9) / 8);
    const dropPct = +Math.max(0, this.flowState.dropWalker(trafficFactor)).toFixed(5);

    await this.db.query(
      `INSERT INTO flow_stats (time, flows_per_sec, active_conversations, bytes_per_sec, drop_pct)
       VALUES (now(), $1, $2, $3, $4)`,
      [flowsPerSec, activeConversations, bytesPerSec, dropPct],
    );
  }

  getWan(points = 80) {
    return this.engine.getWanSeries(points);
  }

  getKpis() {
    return this.engine.getKpis();
  }

  getSnapshot() {
    return this.engine.getSnapshot();
  }

  getDeviceHistory(id: string, points = 100) {
    return this.engine.getDeviceHistory(id, points);
  }
}
