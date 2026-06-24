import { Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { generateRunningConfig } from './config-generator';

export interface ConfigVersion {
  id: number;
  deviceId: number;
  version: number;
  committedBy: string | null;
  committedAt: Date;
  notes: string | null;
}

export interface ConfigSnapshot extends ConfigVersion {
  configText: string;
}

export interface DeviceConfigSummary {
  deviceId: number;
  deviceName: string;
  vendor: string;
  model: string;
  status: string;
  latestVersion: number | null;
  lastSnapshotAt: Date | null;
  hasDrift: boolean;
}

@Injectable()
export class ConfigurationService {
  constructor(private readonly db: DbService) {}

  async listDeviceSummaries(): Promise<DeviceConfigSummary[]> {
    const { rows } = await this.db.query<{
      id: number; name: string; vendor: string; model: string; status: string;
      latest_version: number | null; last_snapshot_at: Date | null;
    }>(`
      SELECT d.id, d.name, d.vendor, d.model, d.status,
             MAX(s.version)      AS latest_version,
             MAX(s.committed_at) AS last_snapshot_at
      FROM devices d
      LEFT JOIN device_config_snapshots s ON s.device_id = d.id
      GROUP BY d.id, d.name, d.vendor, d.model, d.status
      ORDER BY d.id
    `);
    return rows.map((r) => ({
      deviceId: r.id,
      deviceName: r.name,
      vendor: r.vendor ?? '',
      model: r.model ?? '',
      status: r.status,
      latestVersion: r.latest_version,
      lastSnapshotAt: r.last_snapshot_at,
      hasDrift: r.status === 'warn' || r.status === 'down',
    }));
  }

  async getCurrentConfig(deviceId: number): Promise<ConfigSnapshot> {
    const device = await this.getDeviceById(deviceId);
    const ifaces = await this.getInterfaces(deviceId);
    const configText = generateRunningConfig(device, ifaces);

    const { rows } = await this.db.query<{
      id: number; version: number; committed_by: string | null;
      committed_at: Date; notes: string | null;
    }>(
      `SELECT id, version, committed_by, committed_at, notes
       FROM device_config_snapshots
       WHERE device_id = $1
       ORDER BY version DESC LIMIT 1`,
      [deviceId],
    );

    const latest = rows[0];
    return {
      id: latest?.id ?? 0,
      deviceId,
      version: latest?.version ?? 0,
      committedBy: latest?.committed_by ?? null,
      committedAt: latest?.committed_at ?? new Date(),
      notes: latest?.notes ?? null,
      configText,
    };
  }

  async getConfigVersion(deviceId: number, version: number): Promise<ConfigSnapshot> {
    const { rows } = await this.db.query<{
      id: number; version: number; config_text: string;
      committed_by: string | null; committed_at: Date; notes: string | null;
    }>(
      `SELECT * FROM device_config_snapshots WHERE device_id = $1 AND version = $2`,
      [deviceId, version],
    );
    if (!rows[0]) throw new NotFoundException(`Config v${version} not found for device ${deviceId}`);
    return {
      id: rows[0].id,
      deviceId,
      version: rows[0].version,
      configText: rows[0].config_text,
      committedBy: rows[0].committed_by,
      committedAt: rows[0].committed_at,
      notes: rows[0].notes,
    };
  }

  async listVersions(deviceId: number): Promise<ConfigVersion[]> {
    const { rows } = await this.db.query<{
      id: number; version: number; committed_by: string | null;
      committed_at: Date; notes: string | null;
    }>(
      `SELECT id, version, committed_by, committed_at, notes
       FROM device_config_snapshots WHERE device_id = $1
       ORDER BY version DESC`,
      [deviceId],
    );
    return rows.map((r) => ({
      id: r.id, deviceId, version: r.version,
      committedBy: r.committed_by, committedAt: r.committed_at, notes: r.notes,
    }));
  }

  async takeSnapshot(deviceId: number, committedBy?: string, notes?: string): Promise<ConfigSnapshot> {
    const device = await this.getDeviceById(deviceId);
    const ifaces = await this.getInterfaces(deviceId);
    const configText = generateRunningConfig(device, ifaces);

    const { rows: vRows } = await this.db.query<{ max: number | null }>(
      'SELECT MAX(version) AS max FROM device_config_snapshots WHERE device_id = $1',
      [deviceId],
    );
    const nextVersion = (vRows[0].max ?? 0) + 1;

    const { rows } = await this.db.query<{ id: number; committed_at: Date }>(
      `INSERT INTO device_config_snapshots (device_id, version, config_text, committed_by, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, committed_at`,
      [deviceId, nextVersion, configText, committedBy ?? 'system', notes ?? null],
    );

    return {
      id: rows[0].id, deviceId, version: nextVersion,
      configText, committedBy: committedBy ?? 'system',
      committedAt: rows[0].committed_at, notes: notes ?? null,
    };
  }

  async snapshotAll(): Promise<{ snapshotted: number }> {
    const { rows } = await this.db.query<{ id: number }>('SELECT id FROM devices');
    let snapshotted = 0;
    for (const r of rows) {
      await this.takeSnapshot(r.id, 'system', 'scheduled backup').catch(() => {});
      snapshotted++;
    }
    return { snapshotted };
  }

  private async getDeviceById(id: number) {
    const { rows } = await this.db.query<{
      id: number; name: string; ip: string; vendor: string; model: string; role: string;
    }>('SELECT id, name, ip::text AS ip, vendor, model, role FROM devices WHERE id = $1', [id]);
    if (!rows[0]) throw new NotFoundException(`Device ${id} not found`);
    return rows[0];
  }

  private async getInterfaces(deviceId: number) {
    const { rows } = await this.db.query<{
      name: string; description: string; speed: string; vlan: string; status: string; duplex: string;
    }>('SELECT name, COALESCE(description,\'\') AS description, COALESCE(speed,\'1G\') AS speed, vlan, status, duplex FROM interfaces WHERE device_id = $1 ORDER BY name', [deviceId]);
    return rows;
  }
}
