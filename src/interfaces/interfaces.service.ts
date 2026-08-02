import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';

export interface InterfaceFilter {
  deviceId?: number;
  q?: string;
  status?: string; // 'up' | 'down' | 'admin-down' | 'warn'
}

@Injectable()
export class InterfacesService {
  constructor(private readonly db: DbService) {}

  async getInterfaces(filter: InterfaceFilter = {}) {
    const { deviceId, q, status } = filter;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (deviceId) {
      params.push(deviceId);
      conditions.push(`i.device_id = $${params.length}`);
    } else {
      conditions.push(`i.device_id = (SELECT id FROM devices WHERE name = 'core-sw-01' LIMIT 1)`);
    }

    if (q?.trim()) {
      params.push(`%${q.trim()}%`);
      const n = params.length;
      conditions.push(`(i.name ILIKE $${n} OR i.description ILIKE $${n} OR i.vlan ILIKE $${n})`);
    }

    if (status === 'admin-down') {
      conditions.push(`i.admin_status = 'down'`);
    } else if (status === 'up') {
      conditions.push(`i.admin_status = 'up' AND i.status = 'up'`);
    } else if (status === 'down') {
      conditions.push(`i.admin_status = 'up' AND i.status = 'down'`);
    } else if (status === 'warn') {
      conditions.push(`i.admin_status = 'up' AND i.status = 'warn'`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // Latest interface_metrics sample per interface (utilization/in/out/errors)
    // — see AUDIT-REPORT.md L1 and simulation.service.ts's
    // persistInterfaceMetrics(): this table used to be schema-only with no
    // writer, so this used to fall back to two hardcoded lookup arrays
    // indexed by row position. A LATERAL join for "most recent row" is the
    // same pattern reports.service.ts already uses for device_metrics.
    const { rows } = await this.db.query<{
      id: number; name: string; description: string | null;
      vlan: string | null; duplex: string; speed: string | null;
      status: string; admin_status: string; device_id: number;
      in_mbps: string | null; out_mbps: string | null;
      utilization_pct: string | null; error_count: number | null;
      trend: (number | null)[] | null;
    }>(
      `SELECT i.id, i.name, i.description, i.vlan, i.duplex, i.speed,
              i.status, i.admin_status, i.device_id,
              latest.in_mbps, latest.out_mbps, latest.utilization_pct, latest.error_count,
              recent.trend
       FROM interfaces i
       LEFT JOIN LATERAL (
         SELECT in_mbps, out_mbps, utilization_pct, error_count
         FROM interface_metrics WHERE interface_id = i.id ORDER BY time DESC LIMIT 1
       ) latest ON true
       LEFT JOIN LATERAL (
         SELECT array_agg(utilization_pct ORDER BY time) AS trend FROM (
           SELECT utilization_pct, time FROM interface_metrics
           WHERE interface_id = i.id ORDER BY time DESC LIMIT 20
         ) t
       ) recent ON true
       ${where}
       ORDER BY i.name`,
      params,
    );

    return rows.map((r) => {
      const util = r.admin_status === 'down' || r.status === 'down' ? 0 : Number(r.utilization_pct ?? 0);
      return {
        id:          r.id,
        name:        r.name,
        description: r.description ?? '',
        desc:        r.description ?? '',
        vlan:        r.vlan        ?? null,
        duplex:      r.duplex,
        speed:       r.speed       ?? '1G',
        inMbps:      Number(r.in_mbps  ?? 0).toFixed(1),
        outMbps:     Number(r.out_mbps ?? 0).toFixed(1),
        errs:        r.error_count ?? 0,
        util,
        status:      r.status,
        adminStatus: r.admin_status,
        // No metrics yet (e.g. right after boot, before the first
        // simulation persistence tick) → flat at the current utilization
        // rather than an empty/undefined chart.
        trend: (r.trend?.filter((v): v is number => v != null).map(Number)) ?? [],
      };
    });
  }

  async getSummary(deviceId?: number) {
    const scope = deviceId
      ? `device_id = $1`
      : `device_id = (SELECT id FROM devices WHERE name = 'core-sw-01' LIMIT 1)`;
    const params = deviceId ? [deviceId] : [];

    const { rows } = await this.db.query<{
      total: string; up: string; error_down: string; admin_down: string; warn: string;
    }>(`
      SELECT
        COUNT(*)                                                                    AS total,
        COUNT(*) FILTER (WHERE admin_status = 'up' AND status = 'up')              AS up,
        COUNT(*) FILTER (WHERE admin_status = 'up' AND status = 'down')            AS error_down,
        COUNT(*) FILTER (WHERE admin_status = 'down')                              AS admin_down,
        COUNT(*) FILTER (WHERE admin_status = 'up' AND status NOT IN ('up','down')) AS warn
      FROM interfaces
      WHERE ${scope}
    `, params);

    // Real current aggregate throughput across the in-scope interfaces —
    // was a hardcoded '14.8 Gbps' string (AUDIT-REPORT.md L1).
    const { rows: throughputRows } = await this.db.query<{ total_mbps: string | null }>(`
      SELECT SUM(latest.in_mbps + latest.out_mbps) AS total_mbps
      FROM interfaces i
      LEFT JOIN LATERAL (
        SELECT in_mbps, out_mbps FROM interface_metrics
        WHERE interface_id = i.id ORDER BY time DESC LIMIT 1
      ) latest ON true
      WHERE i.${scope}
    `, params);
    const totalMbps = Number(throughputRows[0]?.total_mbps ?? 0);
    const throughput = totalMbps >= 1000 ? `${(totalMbps / 1000).toFixed(1)} Gbps` : `${totalMbps.toFixed(0)} Mbps`;

    return {
      total:     Number(rows[0]?.total      ?? 0),
      up:        Number(rows[0]?.up         ?? 0),
      errorDown: Number(rows[0]?.error_down ?? 0),
      adminDown: Number(rows[0]?.admin_down ?? 0),
      warn:      Number(rows[0]?.warn       ?? 0),
      errored:   Number(rows[0]?.error_down ?? 0), // kept for backward compat
      throughput,
    };
  }

  async getAll(filter: InterfaceFilter = {}) {
    const [interfaces, summary] = await Promise.all([
      this.getInterfaces(filter),
      this.getSummary(filter.deviceId),
    ]);
    return { interfaces, summary };
  }
}
