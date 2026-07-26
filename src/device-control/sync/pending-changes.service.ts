import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { DeviceAction } from '../adapters/vendor-adapter.interface';
import { DeviceWorkerRegistryService } from '../queue/device-worker-registry.service';

interface PendingChangeRow {
  id: number;
  device_id: number;
  requested_by: string;
  requested_at: Date;
  change_type: 'cli_action' | 'snmp_set';
  action_key: string;
  payload: DeviceAction;
  expected_prior_state: Record<string, unknown> | null;
  target_state_description: string | null;
  status: string;
  attempts: number;
}

/**
 * The offline cache/sync queue. A GUI/API action against an unreachable
 * device (including a 'planned' ghost device, which is permanently
 * unreachable until it's given a real connection target) lands here
 * instead of dialing — see device-control/README.md's online/offline
 * section for the full flow. Draining always goes through
 * DeviceActionRunnerService (via DeviceWorkerRegistryService), the exact
 * same execution path a live human action would use, per
 * gui-cli-snmp-unification.md's rule that an agent-initiated change must
 * be indistinguishable in the audit trail from a human one.
 */
@Injectable()
export class PendingChangesService {
  private readonly log = new Logger(PendingChangesService.name);

  constructor(
    private readonly db: DbService,
    private readonly workers: DeviceWorkerRegistryService,
  ) {}

  async queueChange(params: {
    deviceId: number;
    action: DeviceAction;
    requestedBy: string;
    targetStateDescription?: string;
    expectedPriorState?: Record<string, unknown>;
  }): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO pending_changes
         (device_id, requested_by, change_type, action_key, payload, expected_prior_state, target_state_description, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued')
       RETURNING id`,
      [
        params.deviceId,
        params.requestedBy,
        'cli_action',
        params.action.kind,
        JSON.stringify(params.action),
        params.expectedPriorState ? JSON.stringify(params.expectedPriorState) : null,
        params.targetStateDescription ?? null,
      ],
    );
    return rows[0].id;
  }

  async listForDevice(deviceId: number) {
    const { rows } = await this.db.query(
      `SELECT id, requested_by, requested_at, change_type, action_key, payload, status, attempts, last_error, target_state_description
       FROM pending_changes WHERE device_id = $1 ORDER BY requested_at DESC`,
      [deviceId],
    );
    return rows;
  }

  /**
   * Drains queued changes for a device FIFO, on a down->up reachability
   * transition. Each change is re-attempted through the normal execution
   * path; a hard failure marks it 'failed' (retryable — stays visible,
   * attempts increments) rather than silently dropping it. Actual
   * before/after conflict detection (comparing expected_prior_state
   * against a fresh read-back) is intentionally left to a fast-follow —
   * this phase records expected_prior_state when supplied but does not
   * yet block a drain on a mismatch, since none of the 4 vendors'
   * initial action set has a cheap enough pre-check to justify the extra
   * round trip within this session's scope. Documented as a known gap in
   * device-control/README.md, not silently skipped.
   */
  async drainForDevice(deviceId: number): Promise<void> {
    const { rows } = await this.db.query<PendingChangeRow>(
      `SELECT * FROM pending_changes WHERE device_id = $1 AND status IN ('queued', 'failed') ORDER BY requested_at ASC`,
      [deviceId],
    );
    if (rows.length === 0) return;

    this.log.log(`Draining ${rows.length} pending change(s) for device ${deviceId}`);

    for (const row of rows) {
      await this.db.query(`UPDATE pending_changes SET status = 'in_flight', attempts = attempts + 1, last_attempt_at = now() WHERE id = $1`, [row.id]);

      try {
        const result = await this.workers.enqueueAndWait({
          deviceId,
          action: row.payload,
          actorKind: 'agent',
          actorId: `pending-change:${row.id}`,
        });

        if (result.ok) {
          await this.db.query(
            `UPDATE pending_changes SET status = 'applied', applied_audit_id = $2 WHERE id = $1`,
            [row.id, result.lastAuditId ?? null],
          );
        } else {
          await this.db.query(`UPDATE pending_changes SET status = 'failed', last_error = $2 WHERE id = $1`, [row.id, result.error ?? 'unknown error']);
          // Stop draining this device on first failure — later queued
          // changes may depend on this one having applied; don't apply
          // out of order.
          break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.db.query(`UPDATE pending_changes SET status = 'failed', last_error = $2 WHERE id = $1`, [row.id, message]);
        break;
      }
    }
  }
}
