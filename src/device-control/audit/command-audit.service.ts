import { Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';

export type ActorKind = 'human-gui' | 'human-cli' | 'agent' | 'system';
export type AuditTransport = 'ssh' | 'telnet' | 'snmp';
export type AuditResult = 'ok' | 'error' | 'timeout';

/**
 * The durable command audit log — literal command/SNMP-operation text, per
 * gui-cli-snmp-unification.md's "every GUI/agent action must be visible in
 * the same terminal stream a human would see" requirement. Distinct from
 * (and more granular than) device_config_snapshots, which records config
 * *state*; this records *actions taken*.
 */
@Injectable()
export class CommandAuditService {
  constructor(private readonly db: DbService) {}

  async record(entry: {
    deviceId: number;
    sessionId?: string | null;
    actorKind: ActorKind;
    actorId?: string | null;
    transport: AuditTransport;
    commandText: string;
    rawResponse?: string | null;
    result: AuditResult;
  }): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO device_command_audit
         (device_id, session_id, actor_kind, actor_id, transport, command_text, raw_response, result)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        entry.deviceId,
        entry.sessionId ?? null,
        entry.actorKind,
        entry.actorId ?? null,
        entry.transport,
        entry.commandText,
        entry.rawResponse ?? null,
        entry.result,
      ],
    );
    return rows[0].id;
  }

  async recentForDevice(deviceId: number, limit = 100) {
    const { rows } = await this.db.query(
      `SELECT id, session_id, actor_kind, actor_id, transport, command_text, raw_response, result, issued_at
       FROM device_command_audit WHERE device_id = $1 ORDER BY issued_at DESC LIMIT $2`,
      [deviceId, limit],
    );
    return rows;
  }

  async openSession(deviceId: number, transport: AuditTransport, workerJobId?: string): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO device_sessions (device_id, transport, worker_job_id, status)
       VALUES ($1, $2, $3, 'connecting') RETURNING id`,
      [deviceId, transport, workerJobId ?? null],
    );
    return rows[0].id;
  }

  async markSessionOpen(sessionId: string): Promise<void> {
    await this.db.query(`UPDATE device_sessions SET status = 'open' WHERE id = $1`, [sessionId]);
  }

  async closeSession(sessionId: string, finalMode?: string, lastError?: string): Promise<void> {
    await this.db.query(
      `UPDATE device_sessions
       SET status = $2, closed_at = now(), final_mode = $3, last_error = $4
       WHERE id = $1`,
      [sessionId, lastError ? 'error' : 'closed', finalMode ?? null, lastError ?? null],
    );
  }
}
