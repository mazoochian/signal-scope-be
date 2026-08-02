import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { series } from '../common/chart-utils';

@Injectable()
export class OverviewService {
  constructor(private readonly db: DbService) {}

  // Stats and WAN chart still come from the SimulationService via the controller.
  // This service handles the DB-backed sections.

  async getAlerts() {
    const { rows } = await this.db.query<{
      id: string; severity: string; kind: string; title: string;
      device_name: string | null; root_cause: string; fired_at: Date;
    }>(`
      SELECT id, severity, kind, title, device_name, root_cause, fired_at
      FROM alerts
      WHERE cleared_at IS NULL
      ORDER BY
        CASE severity
          WHEN 'Critical' THEN 1 WHEN 'Major' THEN 2
          WHEN 'Minor'    THEN 3 WHEN 'Warning' THEN 4
          ELSE 5
        END,
        fired_at DESC
      LIMIT 6
    `);

    const sevAbbr: Record<string, string> = {
      Critical: 'CRIT', Major: 'MAJ', Minor: 'MIN', Warning: 'WARN', Info: 'INFO',
    };
    return rows.map((r, i) => ({
      id:     i + 1,
      sev:    sevAbbr[r.severity] ?? r.severity,
      kind:   r.kind,
      title:  r.title,
      device: r.device_name ?? '—',
      ago:    formatAgo(r.fired_at),
      rc:     r.root_cause,
    }));
  }

  async getSites() {
    // Real per-site availability (share of device_metrics samples in the
    // last 24h where the site's devices weren't flat-lined down) and a
    // real per-site load "heat" trend (recent CPU-utilization samples,
    // averaged across the site's devices) — both were hardcoded
    // (a fixed six-value lookup array and a synthetic sine wave,
    // AUDIT-REPORT.md L1). Same underlying data reports.service.ts's
    // availability() now uses.
    const { rows } = await this.db.query<{
      display_name: string; avail: string | null; heat: (number | null)[] | null;
    }>(`
      SELECT s.display_name,
             100.0 * COUNT(*) FILTER (WHERE m.packet_loss_pct < 50) / NULLIF(COUNT(*), 0) AS avail,
             (
               SELECT array_agg(bucket_avg ORDER BY bucket)
               FROM (
                 SELECT date_trunc('minute', m2.time) AS bucket, AVG(m2.cpu_pct) AS bucket_avg
                 FROM device_metrics m2
                 JOIN devices d2 ON d2.id = m2.device_id
                 WHERE d2.site_id = s.id AND m2.time > now() - INTERVAL '40 minutes'
                 GROUP BY bucket
                 ORDER BY bucket DESC LIMIT 40
               ) b
             ) AS heat
      FROM sites s
      LEFT JOIN devices d ON d.site_id = s.id
      LEFT JOIN device_metrics m ON m.device_id = d.id AND m.time > now() - INTERVAL '24 hours'
      GROUP BY s.id, s.display_name
      ORDER BY s.id
    `);
    return rows.map((r) => ({
      name:  r.display_name,
      avail: r.avail != null ? +Number(r.avail).toFixed(2) : 100,
      heat:  (r.heat?.filter((v): v is number => v != null).map(Number)) ?? [],
    }));
  }

  async getServices() {
    const { rows } = await this.db.query<{
      name: string; status: string; path: string | null;
      mos: string | null; loss_pct: string | null; jitter: string | null;
    }>(`
      SELECT name, status, path, mos, loss_pct, jitter
      FROM services
      ORDER BY id
      LIMIT 4
    `);

    return rows.map((s, i) => ({
      name:   s.name,
      kind:   s.status,
      status: s.status === 'up' ? 'Healthy' : s.status === 'down' ? 'Down' : 'Degraded',
      path:   s.path    ?? '—',
      mos:    s.mos     ?? '—',
      loss:   s.loss_pct ?? '—',
      jitter: s.jitter  ?? '—',
      trend:  series(30, 51 + i, 80, 15),
    }));
  }

  async getLogs() {
    const { rows } = await this.db.query<{
      time: Date; severity: string; message: string;
    }>(`
      SELECT time, severity, message
      FROM syslog_messages
      ORDER BY time DESC
      LIMIT 9
    `);

    const sevColor: Record<string, string> = {
      INFO: 'text-info', WARN: 'text-warning',
      CRIT: 'text-critical', MAJ: 'text-warning',
    };
    return rows.map((r) => ({
      t:        r.time.toTimeString().slice(0, 8),
      sev:      r.severity,
      sevColor: sevColor[r.severity] ?? 'text-muted-foreground',
      msg:      r.message,
    }));
  }

  // Was a fully static 6-row array of fabricated IPs/apps/throughput —
  // never touched the DB at all (AUDIT-REPORT.md L1, and a finding the
  // original audit missed since it only sampled interfaces/devices/reports
  // /alerts). There's no real per-flow/per-source data anywhere in this
  // schema (flow_stats — see simulation.service.ts's persistFlowStats()
  // — is a single global NetFlow-style aggregate row, not a per-source
  // breakdown, and nothing in this codebase does real NetFlow ingestion),
  // so inventing per-IP rows here would just relocate the fakery. Real
  // fix: repurpose the widget to what real data actually supports — the
  // devices currently pushing the most combined traffic, from live
  // device_metrics. Frontend panel copy updated to match (see
  // app/page.tsx: "Top Devices by Throughput", not "NetFlow").
  async getTalkers() {
    const { rows } = await this.db.query<{
      name: string; role: string; site: string; combined_gbps: string;
    }>(`
      SELECT d.name, d.role, COALESCE(s.name, '—') AS site,
             (latest.ingress_gbps + latest.egress_gbps) AS combined_gbps
      FROM devices d
      LEFT JOIN sites s ON s.id = d.site_id
      JOIN LATERAL (
        SELECT ingress_gbps, egress_gbps FROM device_metrics
        WHERE device_id = d.id ORDER BY time DESC LIMIT 1
      ) latest ON true
      ORDER BY combined_gbps DESC
      LIMIT 6
    `);
    return rows.map((r) => ({
      src: r.name,
      app: r.role,
      mbps: (Number(r.combined_gbps) * 1000).toFixed(1),
    }));
  }

  async getAll(simStats: unknown, simWan: unknown) {
    const [alerts, sites, services, logs, talkers] = await Promise.all([
      this.getAlerts(),
      this.getSites(),
      this.getServices(),
      this.getLogs(),
      this.getTalkers(),
    ]);
    return {
      stats:    simStats,
      wanChart: simWan,
      alerts,
      sites,
      talkers,
      services,
      logs,
    };
  }
}

function formatAgo(d: Date): string {
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  return `${Math.floor(secs / 3600)}h`;
}
