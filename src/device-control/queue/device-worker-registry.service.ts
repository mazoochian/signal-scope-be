import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Queue, QueueEvents, Worker } from 'bullmq';
import { getRedisConnection } from './redis-connection';
import { DeviceActionRunnerService, DeviceActionRequest, DeviceActionResult } from './device-action-runner.service';

/** Idle threshold before a per-device Queue/Worker/QueueEvents trio is eligible for eviction, and how often the sweep runs — both env-overridable, sane defaults for a small fleet. */
const IDLE_EVICT_MS = Number(process.env.DEVICE_WORKER_IDLE_EVICT_MS ?? 30 * 60_000);
const EVICT_SWEEP_INTERVAL_MS = Number(process.env.DEVICE_WORKER_EVICT_SWEEP_MS ?? 5 * 60_000);

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
 * Idle eviction: a per-device entry that hasn't been used in
 * IDLE_EVICT_MS is closed and dropped from the cache by a periodic sweep
 * (own low-frequency BullMQ repeatable job, same pattern as
 * queue/reachability-worker.service.ts) — was previously a documented,
 * unsolved scaling caveat (each entry holds open Redis connections
 * forever). A device with an in-flight job is never evicted regardless of
 * idle time; `ensure()` recreates the trio transparently on the next
 * `enqueueAndWait` if it was evicted, so eviction is invisible to callers
 * beyond the cost of re-dialing Redis.
 */
@Injectable()
export class DeviceWorkerRegistryService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(DeviceWorkerRegistryService.name);
  private readonly queues = new Map<number, Queue<DeviceActionRequest>>();
  private readonly workers = new Map<number, Worker<DeviceActionRequest>>();
  private readonly queueEvents = new Map<number, QueueEvents>();
  private readonly lastUsedAt = new Map<number, number>();
  private evictionQueue?: Queue;
  private evictionWorker?: Worker;

  constructor(private readonly runner: DeviceActionRunnerService) {}

  async onModuleInit() {
    const connection = getRedisConnection();
    this.evictionQueue = new Queue('device-worker-eviction', { connection });
    this.evictionWorker = new Worker('device-worker-eviction', async () => this.sweepIdle(), {
      connection,
      concurrency: 1,
    });
    this.evictionWorker.on('failed', (job, err) => this.log.warn(`Eviction sweep failed: ${err.message}`));
    await this.evictionQueue.add(
      'sweep',
      {},
      { repeat: { every: EVICT_SWEEP_INTERVAL_MS }, jobId: 'device-worker-eviction-sweep', removeOnComplete: 5, removeOnFail: 5 },
    );
  }

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
    this.lastUsedAt.set(req.deviceId, Date.now());
    const job = await queue.add('run-action', req, { removeOnComplete: 200, removeOnFail: 500 });
    return (await job.waitUntilFinished(events, timeoutMs)) as DeviceActionResult;
  }

  /**
   * Closes and drops the cache entry for any device idle past
   * IDLE_EVICT_MS, skipping any device with an active or waiting job
   * regardless of how idle its last-used timestamp looks — a job in
   * flight (or about to run) is a real reason the timestamp is stale, not
   * evidence the device is actually idle.
   */
  async sweepIdle(): Promise<void> {
    const now = Date.now();
    for (const deviceId of [...this.queues.keys()]) {
      const lastUsed = this.lastUsedAt.get(deviceId) ?? 0;
      if (now - lastUsed < IDLE_EVICT_MS) continue;

      const queue = this.queues.get(deviceId)!;
      const [activeCount, waitingCount] = await Promise.all([queue.getActiveCount(), queue.getWaitingCount()]);
      if (activeCount > 0 || waitingCount > 0) continue;

      const worker = this.workers.get(deviceId);
      const events = this.queueEvents.get(deviceId);
      await Promise.all([worker?.close(), queue.close(), events?.close()]);

      this.queues.delete(deviceId);
      this.workers.delete(deviceId);
      this.queueEvents.delete(deviceId);
      this.lastUsedAt.delete(deviceId);
      this.log.log(`Evicted idle device-action worker for device ${deviceId}`);
    }
  }

  async onModuleDestroy() {
    await Promise.all([
      this.evictionWorker?.close(),
      this.evictionQueue?.close(),
      ...[...this.workers.values()].map((w) => w.close()),
      ...[...this.queues.values()].map((q) => q.close()),
      ...[...this.queueEvents.values()].map((e) => e.close()),
    ]);
  }
}
