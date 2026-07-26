import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Job, Queue, QueueEvents, Worker } from 'bullmq';
import { getRedisConnection } from './redis-connection';
import { DeviceActionRunnerService, DeviceActionRequest, DeviceActionResult } from './device-action-runner.service';

/**
 * One BullMQ Queue+Worker+QueueEvents trio per device, created lazily and
 * cached. concurrency:1 per device queue is what preserves command
 * ordering (see device-control/README.md's "per-job, not per-device-sticky"
 * design note) — any worker process instance could pick up any device's
 * job since each job pays its own dial+login cost, which is exactly what
 * makes "agents could live on another server" true without extra
 * coordination. This session runs the Worker in-process with the Nest app;
 * DeviceActionRunnerService has no HTTP/Nest-controller coupling, so
 * extracting a standalone `npm run start:worker` entrypoint later is a
 * process-wiring change, not a rewrite.
 *
 * Known scaling caveat, documented rather than solved this phase: a Map
 * cache that never evicts idle per-device workers is fine for the handful
 * of devices this phase tests against, but would need an idle-eviction
 * policy for a large fleet (each entry holds open Redis connections).
 */
@Injectable()
export class DeviceWorkerRegistryService implements OnModuleDestroy {
  private readonly log = new Logger(DeviceWorkerRegistryService.name);
  private readonly queues = new Map<number, Queue<DeviceActionRequest>>();
  private readonly workers = new Map<number, Worker<DeviceActionRequest>>();
  private readonly queueEvents = new Map<number, QueueEvents>();

  constructor(private readonly runner: DeviceActionRunnerService) {}

  private ensure(deviceId: number) {
    if (this.queues.has(deviceId)) {
      return { queue: this.queues.get(deviceId)!, events: this.queueEvents.get(deviceId)! };
    }
    const connection = getRedisConnection();
    const name = `device-actions-${deviceId}`; // BullMQ queue names can't contain ':' (reserved as a Redis key delimiter internally)
    const queue = new Queue<DeviceActionRequest>(name, { connection });
    const worker = new Worker<DeviceActionRequest>(
      name,
      async (job: Job<DeviceActionRequest>) => this.runner.execute(job.data),
      { connection, concurrency: 1 },
    );
    worker.on('failed', (job, err) => this.log.warn(`Job ${job?.id} for device ${deviceId} failed: ${err.message}`));
    const events = new QueueEvents(name, { connection });

    this.queues.set(deviceId, queue);
    this.workers.set(deviceId, worker);
    this.queueEvents.set(deviceId, events);
    return { queue, events };
  }

  async enqueueAndWait(req: DeviceActionRequest, timeoutMs = 30_000): Promise<DeviceActionResult> {
    const { queue, events } = this.ensure(req.deviceId);
    const job = await queue.add('run-action', req, { removeOnComplete: 200, removeOnFail: 500 });
    return (await job.waitUntilFinished(events, timeoutMs)) as DeviceActionResult;
  }

  async onModuleDestroy() {
    await Promise.all([
      ...[...this.workers.values()].map((w) => w.close()),
      ...[...this.queues.values()].map((q) => q.close()),
      ...[...this.queueEvents.values()].map((e) => e.close()),
    ]);
  }
}
