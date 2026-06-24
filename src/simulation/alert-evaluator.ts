import { Logger } from '@nestjs/common';
import { DbService } from '../db/db.service';

export interface SimSnapshot {
  id: string;
  name: string;
  role: string;
  site: string;
  status: string;
  cpu: number;
  mem: number;
  ingressGbps: number;
  egressGbps: number;
  latencyMs: number;
  packetLossPct: number;
}

interface RuleSpec {
  ruleId: string;
  severity: 'Critical' | 'Major' | 'Warning' | 'Info';
  kind: 'down' | 'warn' | 'info';
  /** Returns the formatted value string if the condition is breached, null otherwise */
  check: (d: SimSnapshot) => string | null;
  /** Returns true if the condition has fully cleared (with hysteresis) */
  cleared: (d: SimSnapshot) => boolean;
  title: (device: string, val: string) => string;
}

const RULES: RuleSpec[] = [
  {
    ruleId: 'device.down',
    severity: 'Critical', kind: 'down',
    check:   (d) => d.status === 'down' ? 'unreachable' : null,
    cleared: (d) => d.status !== 'down',
    title:   (dev) => `Device unreachable: ${dev}`,
  },
  {
    ruleId: 'cpu.critical',
    severity: 'Critical', kind: 'down',
    check:   (d) => d.status !== 'down' && d.cpu > 92 ? `${d.cpu.toFixed(1)}` : null,
    cleared: (d) => d.cpu < 88,
    title:   (dev, val) => `CPU critical on ${dev}: ${val}%`,
  },
  {
    ruleId: 'cpu.major',
    severity: 'Major', kind: 'warn',
    check:   (d) => d.status !== 'down' && d.cpu > 82 && d.cpu <= 92 ? `${d.cpu.toFixed(1)}` : null,
    cleared: (d) => d.cpu < 78,
    title:   (dev, val) => `CPU high on ${dev}: ${val}%`,
  },
  {
    ruleId: 'mem.critical',
    severity: 'Critical', kind: 'down',
    check:   (d) => d.status !== 'down' && d.mem > 95 ? `${d.mem.toFixed(1)}` : null,
    cleared: (d) => d.mem < 90,
    title:   (dev, val) => `Memory critical on ${dev}: ${val}%`,
  },
  {
    ruleId: 'mem.major',
    severity: 'Major', kind: 'warn',
    check:   (d) => d.status !== 'down' && d.mem > 87 && d.mem <= 95 ? `${d.mem.toFixed(1)}` : null,
    cleared: (d) => d.mem < 83,
    title:   (dev, val) => `Memory high on ${dev}: ${val}%`,
  },
  {
    ruleId: 'loss.critical',
    severity: 'Critical', kind: 'down',
    check:   (d) => d.status !== 'down' && d.packetLossPct > 5 ? `${d.packetLossPct.toFixed(2)}` : null,
    cleared: (d) => d.packetLossPct < 3,
    title:   (dev, val) => `Packet loss critical on ${dev}: ${val}%`,
  },
  {
    ruleId: 'loss.major',
    severity: 'Major', kind: 'warn',
    check:   (d) => d.status !== 'down' && d.packetLossPct > 1 && d.packetLossPct <= 5 ? `${d.packetLossPct.toFixed(2)}` : null,
    cleared: (d) => d.packetLossPct < 0.5,
    title:   (dev, val) => `Packet loss elevated on ${dev}: ${val}%`,
  },
  {
    ruleId: 'loss.warning',
    severity: 'Warning', kind: 'warn',
    check:   (d) => d.status !== 'down' && d.packetLossPct > 0.3 && d.packetLossPct <= 1 ? `${d.packetLossPct.toFixed(3)}` : null,
    cleared: (d) => d.packetLossPct < 0.1,
    title:   (dev, val) => `Packet loss warning on ${dev}: ${val}%`,
  },
  {
    ruleId: 'latency.major',
    severity: 'Major', kind: 'warn',
    check:   (d) => d.status !== 'down' && d.latencyMs > 100 ? `${d.latencyMs.toFixed(1)}` : null,
    cleared: (d) => d.latencyMs < 80,
    title:   (dev, val) => `High latency on ${dev}: ${val}ms`,
  },
  {
    ruleId: 'latency.warning',
    severity: 'Warning', kind: 'warn',
    check:   (d) => d.status !== 'down' && d.latencyMs > 40 && d.latencyMs <= 100 ? `${d.latencyMs.toFixed(1)}` : null,
    cleared: (d) => d.latencyMs < 30,
    title:   (dev, val) => `Latency elevated on ${dev}: ${val}ms`,
  },
];

// Rules that escalate together (firing higher cancels lower)
const ESCALATION_GROUPS: string[][] = [
  ['cpu.critical', 'cpu.major'],
  ['mem.critical', 'mem.major'],
  ['loss.critical', 'loss.major', 'loss.warning'],
  ['latency.major', 'latency.warning'],
];

export class AlertEvaluator {
  private readonly log = new Logger(AlertEvaluator.name);
  /** key: "deviceName:ruleId" → alertId */
  private openAlerts = new Map<string, string>();
  private counter = 90300;
  private initialized = false;
  private deviceIds: Map<string, number> | null = null;

  constructor(private readonly db: DbService) {}

  private nextId(): string {
    return `ALR-${this.counter++}`;
  }

  async evaluate(snapshot: SimSnapshot[]): Promise<void> {
    if (!this.initialized) {
      await this.syncFromDb();
    }

    if (!this.deviceIds) {
      this.deviceIds = await this.loadDeviceIds();
    }

    for (const device of snapshot) {
      await this.evaluateDevice(device);
    }
  }

  private async evaluateDevice(d: SimSnapshot): Promise<void> {
    for (const rule of RULES) {
      const val = rule.check(d);
      const key = `${d.name}:${rule.ruleId}`;
      const isOpen = this.openAlerts.has(key);

      if (val !== null && !isOpen) {
        // Clear any lower-priority rule in the same escalation group first
        await this.clearEscalationSiblings(d.name, rule.ruleId);
        await this.fireAlert(d, rule, val);
      } else if (val === null && isOpen && rule.cleared(d)) {
        await this.clearAlert(d.name, rule.ruleId);
      }
    }
  }

  private async clearEscalationSiblings(deviceName: string, ruleId: string): Promise<void> {
    const group = ESCALATION_GROUPS.find((g) => g.includes(ruleId));
    if (!group) return;
    for (const sibling of group) {
      if (sibling !== ruleId) {
        await this.clearAlert(deviceName, sibling);
      }
    }
  }

  private async fireAlert(d: SimSnapshot, rule: RuleSpec, val: string): Promise<void> {
    const key = `${d.name}:${rule.ruleId}`;
    if (this.openAlerts.has(key)) return;

    const id = this.nextId();
    const deviceId = this.deviceIds?.get(d.name) ?? null;
    const title = rule.title(d.name, val);

    // Determine root_cause for device.down: count other open non-cleared alerts
    let rootCause = '—';
    let childCount = 0;
    if (rule.ruleId === 'device.down') {
      childCount = this.openAlerts.size; // rough count of all currently open alerts
      if (childCount > 0) {
        rootCause = 'ROOT';
        // Mark existing open alerts as CHILD (best-effort)
        await this.db.query(
          `UPDATE alerts SET root_cause = 'CHILD' WHERE cleared_at IS NULL AND root_cause = '—' AND device_name != $1`,
          [d.name],
        ).catch(() => {});
      }
    }

    try {
      await this.db.query(
        `INSERT INTO alerts
           (id, severity, kind, title, device_name, device_id, rule, root_cause, child_count, fired_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
         ON CONFLICT (id) DO NOTHING`,
        [id, rule.severity, rule.kind, title, d.name, deviceId, rule.ruleId, rootCause, childCount],
      );
      this.openAlerts.set(key, id);
      this.log.log(`FIRED ${id} [${rule.severity}] ${title}`);
    } catch (err: any) {
      this.log.warn(`Failed to fire alert ${id}: ${err.message}`);
    }
  }

  private async clearAlert(deviceName: string, ruleId: string): Promise<void> {
    const key = `${deviceName}:${ruleId}`;
    const alertId = this.openAlerts.get(key);
    if (!alertId) return;

    try {
      await this.db.query(
        'UPDATE alerts SET cleared_at = now() WHERE id = $1 AND cleared_at IS NULL',
        [alertId],
      );
      this.openAlerts.delete(key);
      this.log.log(`CLEARED ${alertId} (${deviceName}:${ruleId})`);
    } catch (err: any) {
      this.log.warn(`Failed to clear alert ${alertId}: ${err.message}`);
    }
  }

  private async syncFromDb(): Promise<void> {
    try {
      const { rows } = await this.db.query<{ id: string; device_name: string; rule: string }>(
        'SELECT id, device_name, rule FROM alerts WHERE cleared_at IS NULL AND rule IS NOT NULL',
      );
      rows.forEach((r) => {
        if (r.device_name && r.rule) {
          this.openAlerts.set(`${r.device_name}:${r.rule}`, r.id);
        }
      });
      this.initialized = true;
      this.log.log(`Synced ${rows.length} open alerts from DB`);
    } catch (err: any) {
      this.log.warn(`Alert sync failed: ${err.message}`);
      this.initialized = true; // don't retry forever
    }
  }

  private async loadDeviceIds(): Promise<Map<string, number>> {
    const { rows } = await this.db.query<{ id: number; name: string }>('SELECT id, name FROM devices');
    return new Map(rows.map((r) => [r.name, r.id]));
  }
}
