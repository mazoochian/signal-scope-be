import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { series } from '../common/chart-utils';

@Injectable()
export class TelemetryService {
  constructor(private readonly db: DbService) {}

  async getApps() {
    const { rows } = await this.db.query<{
      app: string; bps: string | null; flows: string; percentage: number;
    }>('SELECT app, bps, flows, percentage FROM telemetry_apps ORDER BY percentage DESC');

    return rows.map((r) => ({
      app:   r.app,
      bps:   r.bps ?? '0 bps',
      flows: Number(r.flows),
      pct:   r.percentage,
    }));
  }

  async getSubscriptions() {
    const { rows } = await this.db.query<{
      device_name: string | null; subscription: string;
      sample_rate: string | null; lag: string | null; is_ok: boolean;
    }>(`
      SELECT ts.device_name, ts.subscription, ts.sample_rate, ts.lag, ts.is_ok
      FROM telemetry_subscriptions ts
      ORDER BY ts.id
    `);

    return rows.map((r) => ({
      device: r.device_name  ?? '—',
      sub:    r.subscription,
      rate:   r.sample_rate  ?? '—',
      lag:    r.lag          ?? '—',
      ok:     r.is_ok,
    }));
  }

  getConversations() {
    return [
      { src: '10.42.18.21',  dst: '52.96.165.244',   app: 'HTTPS',  bytes: '4.2 GB', packets: '3.1M', duration: '02:14:11' },
      { src: '10.42.19.105', dst: '10.3.5.10',        app: 'SMB',    bytes: '2.8 GB', packets: '2.0M', duration: '00:48:22' },
      { src: '172.16.4.88',  dst: 'carrier.voice.net',app: 'RTP',    bytes: '1.4 GB', packets: '1.8M', duration: '04:02:18' },
      { src: '10.99.0.4',    dst: '100.64.0.1',       app: 'BGP',    bytes: '912 MB', packets: '612K', duration: '12:18:42' },
      { src: '192.168.50.2', dst: 'vpn.corp.local',   app: 'IPsec',  bytes: '684 MB', packets: '412K', duration: '08:01:09' },
    ];
  }

  // Real latest flow_stats row — was a fully hardcoded 4-line array,
  // another AUDIT-REPORT.md L1-class finding the original audit missed.
  // flow_stats is now populated by simulation.service.ts's
  // persistFlowStats() (previously schema-only, nothing ever wrote to
  // it), so this just needed to actually query it.
  async getFlowStats() {
    const { rows } = await this.db.query<{
      flows_per_sec: string; active_conversations: string; bytes_per_sec: string; drop_pct: string;
    }>(`SELECT flows_per_sec, active_conversations, bytes_per_sec, drop_pct FROM flow_stats ORDER BY time DESC LIMIT 1`);
    const r = rows[0];
    if (!r) {
      return [
        { label: 'Flows/sec',    value: '—' },
        { label: 'Active conv.', value: '—' },
        { label: 'Bytes/sec',    value: '—' },
        { label: 'Drops',        value: '—' },
      ];
    }
    return [
      { label: 'Flows/sec',    value: Number(r.flows_per_sec).toLocaleString() },
      { label: 'Active conv.', value: formatCompact(Number(r.active_conversations)) },
      { label: 'Bytes/sec',    value: formatBytes(Number(r.bytes_per_sec)) },
      { label: 'Drops',        value: `${Number(r.drop_pct).toFixed(3)}%` },
    ];
  }

  // throughputChart (a synthetic sine-wave sparkline) is a different
  // shape of the same L1 problem as flowStats was, but genuinely can't be
  // fixed the same way tonight: there's no telemetry-throughput history
  // table anywhere in this schema (telemetry_apps only carries current
  // bps/flows/percentage, no time series) — a real fix needs a new
  // hypertable + a simulation writer for it, which is bigger scope than
  // wiring an endpoint to data that already exists. Left as-is,
  // deliberately flagged rather than silently working around it.
  async getAll() {
    const [apps, subscriptions, flowStats] = await Promise.all([
      this.getApps(),
      this.getSubscriptions(),
      this.getFlowStats(),
    ]);
    return {
      apps,
      conversations: this.getConversations(),
      subscriptions,
      flowStats,
      throughputChart: series(120, 91, 8, 3),
    };
  }
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

function formatBytes(bytesPerSec: number): string {
  if (bytesPerSec >= 1e9) return `${(bytesPerSec / 1e9).toFixed(2)} GB`;
  if (bytesPerSec >= 1e6) return `${(bytesPerSec / 1e6).toFixed(2)} MB`;
  if (bytesPerSec >= 1e3) return `${(bytesPerSec / 1e3).toFixed(2)} KB`;
  return `${bytesPerSec} B`;
}
