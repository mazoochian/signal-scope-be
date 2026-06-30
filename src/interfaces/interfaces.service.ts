import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { series } from '../common/chart-utils';

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

    const { rows } = await this.db.query<{
      id: number; name: string; description: string | null;
      vlan: string | null; duplex: string; speed: string | null;
      status: string; admin_status: string; device_id: number;
    }>(
      `SELECT i.id, i.name, i.description, i.vlan, i.duplex, i.speed,
              i.status, i.admin_status, i.device_id
       FROM interfaces i
       ${where}
       ORDER BY i.name`,
      params,
    );

    const UTIL   = [22, 41, 6, 78, 12, 91, 4, 67, 0, 33, 51, 18, 28, 96];
    const ERRORS = [0,  0,  0, 2,  0,  0,  0, 17, 0, 3,  0,  0,  0,  128];

    return rows.map((r, i) => {
      const util = r.admin_status === 'down' || r.status === 'down' ? 0 : (UTIL[i % UTIL.length] ?? 20);
      const errs = ERRORS[i % ERRORS.length] ?? 0;
      return {
        id:          r.id,
        name:        r.name,
        description: r.description ?? '',
        desc:        r.description ?? '',
        vlan:        r.vlan        ?? null,
        duplex:      r.duplex,
        speed:       r.speed       ?? '1G',
        inMbps:      (util * 10.2).toFixed(1),
        outMbps:     (util * 8.4).toFixed(1),
        errs,
        util,
        status:      r.status,
        adminStatus: r.admin_status,
        trend:       series(20, r.name.length * 3, 50, 25),
      };
    });
  }

  async getSummary(deviceId?: number) {
    const scope = deviceId
      ? `device_id = ${deviceId}`
      : `device_id = (SELECT id FROM devices WHERE name = 'core-sw-01' LIMIT 1)`;

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
    `);
    return {
      total:     Number(rows[0]?.total      ?? 0),
      up:        Number(rows[0]?.up         ?? 0),
      errorDown: Number(rows[0]?.error_down ?? 0),
      adminDown: Number(rows[0]?.admin_down ?? 0),
      warn:      Number(rows[0]?.warn       ?? 0),
      errored:   Number(rows[0]?.error_down ?? 0), // kept for backward compat
      throughput: '14.8 Gbps',
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
