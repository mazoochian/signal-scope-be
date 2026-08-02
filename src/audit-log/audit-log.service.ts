import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../db/db.service';

export interface AuditEntry {
  actorUserId: number | null;
  actorEmail: string | null;
  action: string;
  targetType?: string;
  targetId?: string | number;
  details?: Record<string, unknown>;
  ipAddress?: string | null;
}

/**
 * AUDIT-REPORT.md M6: nothing recorded who logged in, who changed a role,
 * who added an access grant, or who edited an integration's credentials —
 * a real gap for a five-tier RBAC NMS otherwise carefully built around
 * least-privilege. `record()` is deliberately fire-and-forget from the
 * caller's perspective (never throws) — an audit-logging failure must
 * never block the actual login/write it's recording, only be logged
 * itself so it doesn't silently vanish.
 */
@Injectable()
export class AuditLogService {
  private readonly log = new Logger(AuditLogService.name);

  constructor(private readonly db: DbService) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO audit_log (actor_user_id, actor_email, action, target_type, target_id, details, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          entry.actorUserId,
          entry.actorEmail,
          entry.action,
          entry.targetType ?? null,
          entry.targetId != null ? String(entry.targetId) : null,
          entry.details ? JSON.stringify(entry.details) : null,
          entry.ipAddress ?? null,
        ],
      );
    } catch (err) {
      this.log.warn(`Failed to write audit_log entry (action=${entry.action}): ${err instanceof Error ? err.message : err}`);
    }
  }

  async list(limit = 200): Promise<unknown[]> {
    const { rows } = await this.db.query(
      `SELECT id, time, actor_user_id, actor_email, action, target_type, target_id, details, ip_address
       FROM audit_log ORDER BY time DESC LIMIT $1`,
      [Math.min(Math.max(limit, 1), 1000)],
    );
    return rows;
  }
}
