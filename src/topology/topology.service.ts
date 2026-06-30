import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';

interface RawNode {
  id: string; label: string; kind: string; status: string; x: number; y: number;
}

export interface EnrichedNode extends RawNode {
  alertCounts: Record<string, number>;
  totalAlerts: number;
}

@Injectable()
export class TopologyService {
  constructor(private readonly db: DbService) {}

  async getNodes(): Promise<RawNode[]> {
    const { rows } = await this.db.query<RawNode>(
      'SELECT id, label, kind, status, x, y FROM topology_nodes ORDER BY x, y',
    );
    return rows;
  }

  async getEdges() {
    const { rows } = await this.db.query<{
      from: string; to: string; util: number; status: string;
    }>('SELECT from_node AS "from", to_node AS "to", utilization AS util, status FROM topology_edges');
    return rows;
  }

  async getAlertCounts(): Promise<Record<string, Record<string, number>>> {
    const { rows } = await this.db.query<{
      device_name: string; severity: string; n: string;
    }>(`
      SELECT device_name, severity, COUNT(*) AS n
      FROM alerts
      WHERE cleared_at IS NULL AND device_name IS NOT NULL
      GROUP BY device_name, severity
    `);

    const out: Record<string, Record<string, number>> = {};
    for (const r of rows) {
      if (!out[r.device_name]) out[r.device_name] = {};
      out[r.device_name][r.severity] = Number(r.n);
    }
    return out;
  }

  getPathTrace() {
    return [
      { hop: '1', device: 'acc-sw-fl3-02',        latency: '0.4ms' },
      { hop: '2', device: 'agg-sw-hq-01',          latency: '0.9ms' },
      { hop: '3', device: 'core-sw-01',             latency: '1.2ms' },
      { hop: '4', device: 'edge-rtr-nyc-02',        latency: '1.8ms' },
      { hop: '5', device: 'fw-edge-02',             latency: '2.4ms' },
      { hop: '6', device: 'isp-b · 100.64.0.1',    latency: '8.1ms' },
      { hop: '7', device: '8.8.8.8',               latency: '18.4ms' },
    ];
  }

  async getAll() {
    const [nodes, edges, alertCounts] = await Promise.all([
      this.getNodes(),
      this.getEdges(),
      this.getAlertCounts(),
    ]);

    const enrichedNodes: EnrichedNode[] = nodes.map((n) => {
      const counts = alertCounts[n.label] ?? {};
      return {
        ...n,
        alertCounts: counts,
        totalAlerts: Object.values(counts).reduce((s, c) => s + c, 0),
      };
    });

    return { nodes: enrichedNodes, edges, pathTrace: this.getPathTrace() };
  }
}
