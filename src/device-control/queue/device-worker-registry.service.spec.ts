// Real Redis/BullMQ, no mocks — same discipline as device-control.e2e.spec.ts,
// just scoped to this one service instead of the full app context. Requires
// a live Redis (same precondition as the rest of this module's tests).
import type { DeviceActionRunnerService } from './device-action-runner.service';

// IDLE_EVICT_MS is read from process.env at module-import time (a top-level
// const), so it has to be set before the module is first required — jest's
// per-file module registry makes this safe without leaking into other spec
// files run in the same worker.
process.env.DEVICE_WORKER_IDLE_EVICT_MS = '50';
process.env.DEVICE_WORKER_EVICT_SWEEP_MS = String(60 * 60_000); // keep the real periodic sweep from firing mid-test; tests call sweepIdle() directly

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DeviceWorkerRegistryService } = require('./device-worker-registry.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { closeRedisConnection } = require('./redis-connection');

jest.setTimeout(20_000);

const fakeRunner = {
  execute: async () => ({ ok: true, usedTransport: 'ssh', linesSent: [] }),
} as unknown as DeviceActionRunnerService;

describe('DeviceWorkerRegistryService idle eviction', () => {
  afterAll(async () => {
    await closeRedisConnection();
  });

  it('evicts a device whose entry has never been touched (infinitely idle) and closes queue/worker/events', async () => {
    const service = new DeviceWorkerRegistryService(fakeRunner);
    const deviceId = 900001;

    (service as any).ensure(deviceId);
    const queue = (service as any).queues.get(deviceId);
    const worker = (service as any).workers.get(deviceId);
    const events = (service as any).queueEvents.get(deviceId);
    expect(queue).toBeDefined();

    const queueCloseSpy = jest.spyOn(queue, 'close');
    const workerCloseSpy = jest.spyOn(worker, 'close');
    const eventsCloseSpy = jest.spyOn(events, 'close');

    await service.sweepIdle();

    expect(queueCloseSpy).toHaveBeenCalled();
    expect(workerCloseSpy).toHaveBeenCalled();
    expect(eventsCloseSpy).toHaveBeenCalled();
    expect((service as any).queues.has(deviceId)).toBe(false);
    expect((service as any).workers.has(deviceId)).toBe(false);
    expect((service as any).queueEvents.has(deviceId)).toBe(false);
  });

  it('does not evict a device with a job still waiting to be picked up, even past the idle threshold', async () => {
    const service = new DeviceWorkerRegistryService(fakeRunner);
    const deviceId = 900002;

    const { queue } = (service as any).ensure(deviceId);
    const worker = (service as any).workers.get(deviceId);
    await worker.pause(); // keep the job 'waiting' instead of letting the worker pick it up immediately
    (service as any).lastUsedAt.set(deviceId, Date.now() - 10_000); // well past the 50ms threshold

    await queue.add('run-action', { deviceId, actorKind: 'system' });
    await service.sweepIdle();

    expect((service as any).queues.has(deviceId)).toBe(true);

    // Cleanup: resume so the job drains, then close everything explicitly.
    await worker.resume();
    await new Promise((r) => setTimeout(r, 300));
    await Promise.all([worker.close(), queue.close(), (service as any).queueEvents.get(deviceId)?.close()]);
  });

  it('does not evict a device used more recently than the idle threshold', async () => {
    const service = new DeviceWorkerRegistryService(fakeRunner);
    const deviceId = 900003;

    (service as any).ensure(deviceId);
    (service as any).lastUsedAt.set(deviceId, Date.now()); // just used

    await service.sweepIdle();
    expect((service as any).queues.has(deviceId)).toBe(true);

    // Cleanup.
    const queue = (service as any).queues.get(deviceId);
    const worker = (service as any).workers.get(deviceId);
    const events = (service as any).queueEvents.get(deviceId);
    await Promise.all([worker.close(), queue.close(), events.close()]);
  });
});
