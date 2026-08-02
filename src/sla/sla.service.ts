import { Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { CreateSlaParameterDto, UpdateSlaParameterDto } from './dto/sla-parameter.dto';

export interface SlaParameter {
  id: number;
  name: string;
  metric: string;
  target_value: number;
  operator: string;
  scope_type: string;
  scope_value: string | null;
  enabled: boolean;
}

export interface SlaStatusItem {
  parameter: SlaParameter;
  currentValue: number | null;
  targetMet: boolean | null;
}

@Injectable()
export class SlaService {
  constructor(private readonly db: DbService) {}

  async list(): Promise<SlaParameter[]> {
    const { rows } = await this.db.query<SlaParameter>(
      'SELECT * FROM sla_parameters ORDER BY id',
    );
    return rows;
  }

  async create(dto: CreateSlaParameterDto): Promise<SlaParameter> {
    const { rows } = await this.db.query<SlaParameter>(
      `INSERT INTO sla_parameters
         (name, metric, target_value, operator, scope_type, scope_value, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [dto.name, dto.metric, dto.target_value, dto.operator, dto.scope_type, dto.scope_value ?? null, dto.enabled ?? true],
    );
    return rows[0];
  }

  async update(id: number, dto: UpdateSlaParameterDto): Promise<SlaParameter> {
    const { rows } = await this.db.query<SlaParameter>(
      `UPDATE sla_parameters SET
         name         = COALESCE($2, name),
         metric       = COALESCE($3, metric),
         target_value = COALESCE($4, target_value),
         operator     = COALESCE($5, operator),
         scope_type   = COALESCE($6, scope_type),
         scope_value  = COALESCE($7, scope_value),
         enabled      = COALESCE($8, enabled),
         updated_at   = now()
       WHERE id = $1 RETURNING *`,
      [id, dto.name, dto.metric, dto.target_value, dto.operator, dto.scope_type, dto.scope_value, dto.enabled],
    );
    if (!rows[0]) throw new NotFoundException(`SLA parameter ${id} not found`);
    return rows[0];
  }

  async remove(id: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'DELETE FROM sla_parameters WHERE id = $1', [id],
    );
    return (rowCount ?? 0) > 0;
  }

  async getStatus(): Promise<SlaStatusItem[]> {
    const params = await this.list();
    const enabled = params.filter((p) => p.enabled);
    return Promise.all(enabled.map((p) => this.evaluate(p)));
  }

  async getComplianceSummary(): Promise<{ pct: number; met: number; total: number }> {
    const items = await this.getStatus();
    const evaluated = items.filter((i) => i.targetMet !== null);
    const met = evaluated.filter((i) => i.targetMet === true).length;
    const total = evaluated.length;
    const pct = total === 0 ? 100 : Math.round((met / total) * 1000) / 10;
    return { pct, met, total };
  }

  private async evaluate(p: SlaParameter): Promise<SlaStatusItem> {
    let currentValue: number | null = null;

    try {
      switch (p.metric) {
        case 'availability': {
          const { rows } = await this.db.query<{ up: string; total: string }>(
            `SELECT COUNT(*) FILTER (WHERE status = 'up') AS up, COUNT(*) AS total FROM devices`,
          );
          const r = rows[0];
          currentValue = r.total === '0' ? 100 : (Number(r.up) / Number(r.total)) * 100;
          break;
        }
        case 'cpu': {
          const { rows } = await this.db.query<{ avg_cpu: string }>(`
            SELECT AVG(latest.cpu_pct) AS avg_cpu FROM (
              SELECT DISTINCT ON (device_id) cpu_pct
              FROM device_metrics ORDER BY device_id, time DESC
            ) latest
          `);
          currentValue = rows[0]?.avg_cpu != null ? Number(rows[0].avg_cpu) : null;
          break;
        }
        case 'memory': {
          const { rows } = await this.db.query<{ avg_mem: string }>(`
            SELECT AVG(latest.mem_pct) AS avg_mem FROM (
              SELECT DISTINCT ON (device_id) mem_pct
              FROM device_metrics ORDER BY device_id, time DESC
            ) latest
          `);
          currentValue = rows[0]?.avg_mem != null ? Number(rows[0].avg_mem) : null;
          break;
        }
        case 'latency': {
          const { rows } = await this.db.query<{ avg_lat: string }>(`
            SELECT AVG(latest.latency_ms) AS avg_lat FROM (
              SELECT DISTINCT ON (device_id) latency_ms
              FROM device_metrics ORDER BY device_id, time DESC
            ) latest
          `);
          currentValue = rows[0]?.avg_lat != null ? Number(rows[0].avg_lat) : null;
          break;
        }
        case 'packet_loss': {
          const { rows } = await this.db.query<{ avg_loss: string }>(`
            SELECT AVG(latest.packet_loss_pct) AS avg_loss FROM (
              SELECT DISTINCT ON (device_id) packet_loss_pct
              FROM device_metrics ORDER BY device_id, time DESC
            ) latest
          `);
          currentValue = rows[0]?.avg_loss != null ? Number(rows[0].avg_loss) : null;
          break;
        }
        case 'interface_util': {
          const { rows } = await this.db.query<{ avg_util: string }>(`
            SELECT AVG(latest.util_pct) AS avg_util FROM (
              SELECT DISTINCT ON (interface_id) util_pct
              FROM interface_metrics ORDER BY interface_id, time DESC
            ) latest
          `);
          currentValue = rows[0]?.avg_util != null ? Number(rows[0].avg_util) : null;
          break;
        }
      }
    } catch {
      currentValue = null;
    }

    let targetMet: boolean | null = null;
    if (currentValue !== null) {
      const t = Number(p.target_value);
      if (p.operator === '>=') targetMet = currentValue >= t;
      else if (p.operator === '<=') targetMet = currentValue <= t;
      else if (p.operator === '=') targetMet = Math.abs(currentValue - t) < 0.001;
    }

    return { parameter: p, currentValue, targetMet };
  }
}
