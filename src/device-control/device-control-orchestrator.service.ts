import { Injectable, Logger } from '@nestjs/common';
import { DeviceAction } from './adapters/vendor-adapter.interface';
import { DeviceConnectionService } from './connection/device-connection.service';
import { DeviceWorkerRegistryService } from './queue/device-worker-registry.service';
import { PendingChangesService } from './sync/pending-changes.service';
import { DeviceActionResult } from './queue/device-action-runner.service';

export type OrchestratorOutcome =
  | { mode: 'executed'; result: DeviceActionResult }
  | { mode: 'queued'; pendingChangeId: number };

/**
 * The online/offline decision point: a known-down (or connectionless
 * 'planned' ghost) device always queues into pending_changes without
 * attempting a dial; a device believed reachable is attempted live, and
 * falls back to the same queue on a transport-level failure rather than
 * surfacing a bare error — this is what makes "cache changes while
 * offline" invisible to the caller as a special case (see
 * device-control/README.md's online/offline section).
 */
@Injectable()
export class DeviceControlOrchestratorService {
  private readonly log = new Logger(DeviceControlOrchestratorService.name);

  constructor(
    private readonly connections: DeviceConnectionService,
    private readonly workers: DeviceWorkerRegistryService,
    private readonly pending: PendingChangesService,
  ) {}

  async submit(deviceId: number, action: DeviceAction, requestedBy: string): Promise<OrchestratorOutcome> {
    const device = await this.connections.getDevice(deviceId);

    if (device.connectionKind === 'planned' || device.status === 'down') {
      const pendingChangeId = await this.pending.queueChange({ deviceId, action, requestedBy });
      return { mode: 'queued', pendingChangeId };
    }

    try {
      const result = await this.workers.enqueueAndWait({ deviceId, action, actorKind: 'human-gui', actorId: requestedBy });
      if (!result.ok && /connect|timed out|ECONNREFUSED|EHOSTUNREACH/i.test(result.error ?? '')) {
        // Application-level errors (e.g. "no CLI plan for this action") are
        // surfaced as-is, not queued — queuing wouldn't help. Only
        // transport-level unreachability falls back to the offline queue.
        const pendingChangeId = await this.pending.queueChange({ deviceId, action, requestedBy });
        return { mode: 'queued', pendingChangeId };
      }
      return { mode: 'executed', result };
    } catch (err) {
      this.log.warn(`Live execution failed for device ${deviceId}, queuing instead: ${err instanceof Error ? err.message : err}`);
      const pendingChangeId = await this.pending.queueChange({ deviceId, action, requestedBy });
      return { mode: 'queued', pendingChangeId };
    }
  }
}
