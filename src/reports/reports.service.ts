import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';

type Range = '24h' | '7d' | '30d';

function rangeInterval(range: Range): string {
  return range === '24h' ? '24 hours' : range === '7d' ? '7 days' : '30 days';
}

@Injectable()
export class ReportsService {
  constructor(private readonly db: DbService) {}

  async deviceHealth(range: Range) {
    const interval = rangeInterval(range);

    const { rows: counts } = await this.db.query<{ status: string; n: string }>(
      `SELECT status, COUNT(*) AS n FROM devices GROUP BY status`,
    );
    const total = counts.reduce((s, r) => s + Number(r.n), 0);
    const up   = Number(counts.find((r) => r.status === 'up')?.n ?? 0);
    const warn = Number(counts.find((r) => r.status === 'warn')?.n ?? 0);
    const down = Number(counts.find((r) => r.status === 'down')?.n ?? 0);

    const { rows: topCpu } = await this.db.query<{
      name: string; site: string; cpu: string; mem: string;
    }>(`
      SELECT d.name, COALESCE(s.name, '—') AS site,
             ROUND(latest.cpu_pct::numeric, 1)::text AS cpu,
             ROUND(latest.mem_pct::numeric, 1)::text AS mem
      FROM devices d
      LEFT JOIN sites s ON s.id = d.site_id
      LEFT JOIN LATERAL (
        SELECT cpu_pct, mem_pct FROM device_metrics
        WHERE device_id = d.id ORDER BY time DESC LIMIT 1
      ) latest ON true
      WHERE latest.cpu_pct IS NOT NULL
      ORDER BY latest.cpu_pct DESC LIMIT 10
    `);

    const { rows: topMem } = await this.db.query<{
      name: string; site: string; cpu: string; mem: string;
    }>(`
      SELECT d.name, COALESCE(s.name, '—') AS site,
             ROUND(latest.cpu_pct::numeric, 1)::text AS cpu,
             ROUND(latest.mem_pct::numeric, 1)::text AS mem
      FROM devices d
      LEFT JOIN sites s ON s.id = d.site_id
      LEFT JOIN LATERAL (
        SELECT cpu_pct, mem_pct FROM device_metrics
        WHERE device_id = d.id ORDER BY time DESC LIMIT 1
      ) latest ON true
      WHERE latest.mem_pct IS NOT NULL
      ORDER BY latest.mem_pct DESC LIMIT 10
    `);

    const { rows: topAlerts } = await this.db.query<{ name: string; alert_count: string }>(`
      SELECT d.name, COUNT(a.id) AS alert_count
      FROM devices d
      JOIN alerts a ON a.device_name = d.name
      WHERE a.fired_at > now() - INTERVAL '${interval}'
      GROUP BY d.name ORDER BY alert_count DESC LIMIT 10
    `);

    return {
      summary: { total, up, warn, down },
      topByCpu: topCpu.map((r) => ({ ...r, cpu: Number(r.cpu), mem: Number(r.mem) })),
      topByMem: topMem.map((r) => ({ ...r, cpu: Number(r.cpu), mem: Number(r.mem) })),
      topByAlerts: topAlerts.map((r) => ({ name: r.name, alertCount: Number(r.alert_count) })),
    };
  }

  async interfaceUtilization(range: Range) {
    const interval = rangeInterval(range);
    const { rows } = await this.db.query<{
      iface_name: string; device_name: string;
      avg_in: string; avg_out: string; peak_in: string; peak_out: string;
    }>(`
      SELECT
        i.name AS iface_name,
        d.name AS device_name,
        ROUND(AVG(m.in_mbps)::numeric, 2)::text  AS avg_in,
        ROUND(AVG(m.out_mbps)::numeric, 2)::text  AS avg_out,
        ROUND(MAX(m.in_mbps)::numeric, 2)::text  AS peak_in,
        ROUND(MAX(m.out_mbps)::numeric, 2)::text  AS peak_out
      FROM interfaces i
      JOIN devices d ON d.id = i.device_id
      JOIN interface_metrics m ON m.interface_id = i.id
      WHERE m.time > now() - INTERVAL '${interval}'
      GROUP BY i.id, i.name, d.name
      ORDER BY AVG(m.in_mbps) + AVG(m.out_mbps) DESC
      LIMIT 20
    `);

    return {
      interfaces: rows.map((r) => ({
        name: r.iface_name,
        device: r.device_name,
        avgIn: Number(r.avg_in),
        avgOut: Number(r.avg_out),
        peakIn: Number(r.peak_in),
        peakOut: Number(r.peak_out),
      })),
    };
  }

  async alertSummary(range: Range) {
    const interval = rangeInterval(range);

    const { rows: bySev } = await this.db.query<{ severity: string; n: string }>(`
      SELECT severity, COUNT(*) AS n FROM alerts
      WHERE fired_at > now() - INTERVAL '${interval}'
      GROUP BY severity ORDER BY n DESC
    `);

    const { rows: bySite } = await this.db.query<{ site: string; n: string }>(`
      SELECT COALESCE(s.name, 'Unknown') AS site, COUNT(a.id) AS n
      FROM alerts a
      LEFT JOIN devices d ON d.name = a.device_name
      LEFT JOIN sites s ON s.id = d.site_id
      WHERE a.fired_at > now() - INTERVAL '${interval}'
      GROUP BY s.name ORDER BY n DESC
    `);

    const { rows: topDevices } = await this.db.query<{ device_name: string; n: string }>(`
      SELECT device_name, COUNT(*) AS n FROM alerts
      WHERE fired_at > now() - INTERVAL '${interval}' AND device_name IS NOT NULL
      GROUP BY device_name ORDER BY n DESC LIMIT 10
    `);

    const total = bySev.reduce((s, r) => s + Number(r.n), 0);
    const critical = Number(bySev.find((r) => r.severity === 'Critical')?.n ?? 0);
    const major    = Number(bySev.find((r) => r.severity === 'Major')?.n ?? 0);
    const minor    = Number(bySev.find((r) => r.severity === 'Minor')?.n ?? 0);

    // Mean time to resolve: real average of (cleared_at - fired_at) over
    // alerts that both fired and cleared within the requested window. Was
    // hardcoded to 0 unconditionally (AUDIT-REPORT.md L1) — `alerts` has
    // carried real fired_at/cleared_at columns the whole time, this just
    // hadn't been wired up.
    const { rows: mttrRows } = await this.db.query<{ avg_seconds: string | null }>(`
      SELECT AVG(EXTRACT(EPOCH FROM (cleared_at - fired_at))) AS avg_seconds
      FROM alerts
      WHERE cleared_at IS NOT NULL AND fired_at > now() - INTERVAL '${interval}'
    `);
    const mttrSeconds = Number(mttrRows[0]?.avg_seconds ?? 0);

    return {
      summary: { total, critical, major, minor },
      bySeverity: bySev.map((r) => ({ severity: r.severity, count: Number(r.n) })),
      bySite: bySite.map((r) => ({ site: r.site, count: Number(r.n) })),
      topDevices: topDevices.map((r) => ({ name: r.device_name, alertCount: Number(r.n) })),
      mttr: Math.round(mttrSeconds / 60), // minutes — matches the unit the reports UI already labels this as
    };
  }

  async availability(range: Range = '7d') {
    const interval = rangeInterval(range);

    // Real per-device availability: the share of device_metrics samples in
    // the window where the device wasn't flat-lined down (the simulation
    // engine reports packet_loss_pct=100/latency=999 for a down device —
    // see simulation.engine.ts's ouStep). Was a hardcoded status→number
    // lookup (up→100/warn→95/down→0), the same value regardless of how
    // long a device had actually been in that state (AUDIT-REPORT.md L1).
    // Falls back to that same status-based estimate only for a device with
    // no samples yet in the window (e.g. right after boot).
    const { rows } = await this.db.query<{
      name: string; site: string; status: string; availability: string | null;
    }>(`
      SELECT d.name, COALESCE(s.name, '—') AS site, d.status,
             m.pct AS availability
      FROM devices d
      LEFT JOIN sites s ON s.id = d.site_id
      LEFT JOIN LATERAL (
        SELECT 100.0 * COUNT(*) FILTER (WHERE packet_loss_pct < 50) / NULLIF(COUNT(*), 0) AS pct
        FROM device_metrics
        WHERE device_id = d.id AND time > now() - INTERVAL '${interval}'
      ) m ON true
      ORDER BY d.name
    `);

    return {
      devices: rows.map((r) => ({
        name: r.name,
        site: r.site,
        status: r.status,
        availability: r.availability != null
          ? +Number(r.availability).toFixed(2)
          : (r.status === 'up' ? 100 : r.status === 'warn' ? 95 : 0),
      })),
    };
  }
}
