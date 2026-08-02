import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';

@Injectable()
export class AlertsService {
  constructor(private readonly db: DbService) {}

  async getAlerts() {
    const { rows } = await this.db.query<{
      id: string; severity: string; kind: string; title: string;
      device_name: string | null; iface: string | null; rule: string | null;
      acknowledged: boolean; suppressed: boolean; root_cause: string;
      child_count: number; fired_at: Date;
    }>(`
      SELECT id, severity, kind, title, device_name, iface, rule,
             acknowledged, suppressed, root_cause, child_count, fired_at
      FROM alerts
      WHERE cleared_at IS NULL
      ORDER BY
        CASE severity
          WHEN 'Critical' THEN 1 WHEN 'Major' THEN 2
          WHEN 'Minor'    THEN 3 WHEN 'Warning' THEN 4
          ELSE 5
        END,
        fired_at DESC
    `);

    return rows.map((r) => ({
      id:         r.id,
      sev:        r.severity,
      kind:       r.kind,
      title:      r.title,
      device:     r.device_name ?? '—',
      iface:      r.iface       ?? '—',
      rule:       r.rule        ?? '—',
      ack:        r.acknowledged,
      suppressed: r.suppressed,
      age:        formatAge(r.fired_at),
      rc:         r.root_cause,
      children:   r.child_count,
    }));
  }

  async getSummary() {
    const { rows } = await this.db.query<{ severity: string; n: string }>(`
      SELECT severity, COUNT(*) AS n
      FROM alerts WHERE cleared_at IS NULL
      GROUP BY severity
    `);

    const colorMap: Record<string, string> = {
      Critical: 'text-critical', Major: 'text-warning',
      Minor: 'text-info', Warning: 'text-warning', Info: 'text-muted-foreground',
    };
    const order = ['Critical', 'Major', 'Minor', 'Warning', 'Info'];
    const countMap = Object.fromEntries(rows.map((r) => [r.severity, Number(r.n)]));

    // Real hourly alert-fired counts over the last 24h — was a fully
    // synthetic sine-wave sparkline (AUDIT-REPORT.md L1's `series()` call).
    // alerts.fired_at is real and always populated, so this needed no new
    // data source, just a query.
    const { rows: volumeRows } = await this.db.query<{ bucket: Date; n: string }>(`
      SELECT date_trunc('hour', fired_at) AS bucket, COUNT(*) AS n
      FROM alerts
      WHERE fired_at > now() - INTERVAL '24 hours'
      GROUP BY bucket ORDER BY bucket
    `);
    const volumeByHour = new Map(volumeRows.map((r) => [r.bucket.toISOString().slice(0, 13), Number(r.n)]));
    const volumeChart: number[] = [];
    for (let h = 23; h >= 0; h--) {
      const bucket = new Date(Date.now() - h * 3600_000).toISOString().slice(0, 13);
      volumeChart.push(volumeByHour.get(bucket) ?? 0);
    }

    // Real root-cause chain: alert-evaluator.ts (see fireAlert()) already
    // marks a device-down alert ROOT and every other currently-open alert
    // CHILD when it fires — a real, if coarse, correlation model that was
    // never actually surfaced; this endpoint returned a fixed five-line
    // fictional BGP scenario regardless of what was really open
    // (AUDIT-REPORT.md L1).
    const { rows: chainRows } = await this.db.query<{
      title: string; device_name: string | null; rule: string | null; root_cause: string;
    }>(`
      SELECT title, device_name, rule, root_cause FROM alerts
      WHERE cleared_at IS NULL AND root_cause IN ('ROOT', 'CHILD')
      ORDER BY (root_cause = 'ROOT') DESC, fired_at ASC
      LIMIT 6
    `);
    const rootCauseChain = chainRows.map((r) => `${r.rule ?? r.device_name ?? '—'}::${r.title}`);

    return {
      severityCounts: order.map((label) => ({
        label,
        n:     countMap[label] ?? 0,
        color: colorMap[label] ?? 'text-muted-foreground',
      })),
      volumeChart,
      rootCauseChain,
    };
  }

  async getAll() {
    const [alerts, summary] = await Promise.all([
      this.getAlerts(),
      this.getSummary(),
    ]);
    const open       = alerts.filter((a) => !a.suppressed).length;
    const acked      = alerts.filter((a) => a.ack).length;
    const suppressed = alerts.filter((a) => a.suppressed).length;
    return { alerts, open, acked, suppressed, ...summary };
  }

  async getStats() {
    const { rows } = await this.db.query<{ severity: string; n: string; ack: string }>(`
      SELECT severity, COUNT(*) AS n, SUM(CASE WHEN acknowledged THEN 1 ELSE 0 END) AS ack
      FROM alerts WHERE cleared_at IS NULL
      GROUP BY severity
    `);
    let open = 0, critical = 0, major = 0, acknowledged = 0;
    for (const r of rows) {
      const n = Number(r.n);
      open += n;
      acknowledged += Number(r.ack);
      if (r.severity === 'Critical') critical += n;
      if (r.severity === 'Major')    major    += n;
    }
    return { open, critical, major, acknowledged };
  }

  async acknowledge(id: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE alerts SET acknowledged = true WHERE id = $1`,
      [id],
    );
    if ((rowCount ?? 0) > 0) {
      const { rows } = await this.db.query<{ severity: string; device_name: string | null }>(
        'SELECT severity, device_name FROM alerts WHERE id = $1', [id],
      );
      if (rows[0]) {
        await this.db.query(
          `INSERT INTO alert_history (time, alert_id, severity, state, device_name) VALUES (now(),$1,$2,'acknowledged',$3)`,
          [id, rows[0].severity, rows[0].device_name],
        );
      }
    }
    return (rowCount ?? 0) > 0;
  }

  async suppress(id: string): Promise<boolean> {
    const { rows: cur } = await this.db.query<{ suppressed: boolean }>(
      'SELECT suppressed FROM alerts WHERE id = $1', [id],
    );
    if (!cur[0]) return false;
    const next = !cur[0].suppressed;
    const { rowCount } = await this.db.query(
      `UPDATE alerts SET suppressed = $2, suppressed_at = $3 WHERE id = $1`,
      [id, next, next ? new Date() : null],
    );
    if ((rowCount ?? 0) > 0) {
      const { rows } = await this.db.query<{ severity: string; device_name: string | null }>(
        'SELECT severity, device_name FROM alerts WHERE id = $1', [id],
      );
      if (rows[0]) {
        await this.db.query(
          `INSERT INTO alert_history (time, alert_id, severity, state, device_name) VALUES (now(),$1,$2,$3,$4)`,
          [id, rows[0].severity, next ? 'suppressed' : 'unsuppressed', rows[0].device_name],
        );
      }
    }
    return (rowCount ?? 0) > 0;
  }

  async getAlertsByDevice(deviceName: string) {
    const { rows } = await this.db.query<{ severity: string; n: string }>(`
      SELECT severity, COUNT(*) AS n
      FROM alerts
      WHERE device_name = $1 AND cleared_at IS NULL
      GROUP BY severity`,
      [deviceName],
    );
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.severity] = Number(r.n);
    return counts;
  }
}

function formatAge(firedAt: Date): string {
  const secs = Math.floor((Date.now() - firedAt.getTime()) / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return [h, m, s].map((v) => v.toString().padStart(2, '0')).join(':');
}
