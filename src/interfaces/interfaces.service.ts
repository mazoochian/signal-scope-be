import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { series } from '../common/chart-utils';

@Injectable()
export class InterfacesService {
  constructor(private readonly db: DbService) {}

  async getInterfaces(deviceId?: number) {
    const { rows } = await this.db.query<{
      id: number; name: string; description: string | null;
      vlan: string | null; duplex: string; speed: string | null; status: string;
      device_id: number;
    }>(
      deviceId
        ? `SELECT i.id, i.name, i.description, i.vlan, i.duplex, i.speed, i.status, i.device_id
           FROM interfaces i WHERE i.device_id = $1 ORDER BY i.name`
        : `SELECT i.id, i.name, i.description, i.vlan, i.duplex, i.speed, i.status, i.device_id
           FROM interfaces i
           WHERE i.device_id = (SELECT id FROM devices WHERE name = 'core-sw-01' LIMIT 1)
           ORDER BY i.id`,
      deviceId ? [deviceId] : [],
    );

    const UTIL   = [22, 41, 6, 78, 12, 91, 4, 67, 0, 33, 51, 18, 28, 96];
    const ERRORS = [0,  0,  0, 2,  0,  0,  0, 17, 0, 3,  0,  0,  0,  128];

    return rows.map((r, i) => {
      const util = UTIL[i % UTIL.length] ?? 20;
      const errs = ERRORS[i % ERRORS.length] ?? 0;
      return {
        id:      r.id,
        name:    r.name,
        description: r.description ?? '',
        desc:    r.description ?? '',
        vlan:    r.vlan        ?? null,
        duplex:  r.duplex,
        speed:   r.speed       ?? '1G',
        inMbps:  (util * 10.2).toFixed(1),
        outMbps: (util * 8.4).toFixed(1),
        errs,
        util,
        status:  r.status,
        trend:   series(20, r.name.length * 3, 50, 25),
      };
    });
  }

  async getSummary() {
    const { rows } = await this.db.query<{
      total: string; up: string; errored: string;
    }>(`
      SELECT
        COUNT(*)                                             AS total,
        COUNT(*) FILTER (WHERE status = 'up')               AS up,
        COUNT(*) FILTER (WHERE status NOT IN ('up','down'))  AS errored
      FROM interfaces
    `);
    return {
      total:      Number(rows[0]?.total   ?? 0),
      up:         Number(rows[0]?.up      ?? 0),
      errored:    Number(rows[0]?.errored ?? 0),
      throughput: '14.8 Gbps',
    };
  }

  async getAll(deviceId?: number) {
    const [interfaces, summary] = await Promise.all([
      this.getInterfaces(deviceId),
      this.getSummary(),
    ]);
    return { interfaces, summary };
  }
}
