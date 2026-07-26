import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { Socket } from 'net';
import { getRedisConnection } from './redis-connection';
import { DbService } from '../../db/db.service';
import { DeviceConnectionService } from '../connection/device-connection.service';
import { PendingChangesService } from '../sync/pending-changes.service';
import { snmpProbeReachable } from '../transport/snmp-transport';

const SWEEP_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 3_000;

/**
 * Lightweight online/offline tracking — reuses devices.status rather than a
 * new table (see device-control/README.md's schema notes). A repeatable
 * BullMQ job (any worker instance can pick it up, same reasoning as
 * device-action jobs) TCP-probes every non-'planned' device's primary
 * connection port, or does an SNMP GET of sysUpTime where SNMP credentials
 * exist — never a full login, this is a cheap reachability signal, not a
 * session. 'planned' ghost devices are never probed and never flagged
 * down, since they're not deployed yet.
 */
@Injectable()
export class ReachabilityWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ReachabilityWorkerService.name);
  private queue!: Queue;
  private worker!: Worker;

  constructor(
    private readonly db: DbService,
    private readonly connections: DeviceConnectionService,
    private readonly pending: PendingChangesService,
  ) {}

  async onModuleInit() {
    const connection = getRedisConnection();
    this.queue = new Queue('reachability', { connection });
    this.worker = new Worker('reachability', async () => this.sweep(), { connection, concurrency: 1 });
    this.worker.on('failed', (job, err) => this.log.warn(`Reachability sweep failed: ${err.message}`));
    await this.queue.add(
      'sweep',
      {},
      { repeat: { every: SWEEP_INTERVAL_MS }, jobId: 'reachability-sweep', removeOnComplete: 5, removeOnFail: 5 },
    );
  }

  async sweep(): Promise<void> {
    const { rows } = await this.db.query<{ id: number; status: string }>(
      `SELECT id, status FROM devices WHERE connection_kind != 'planned'`,
    );

    for (const device of rows) {
      const target = await this.connections.getPrimaryTarget(device.id);
      if (!target) continue; // no target configured yet — nothing to probe

      const reachable =
        target.transport === 'snmp'
          ? await this.probeSnmp(device.id, target.host, target.port)
          : await this.probeTcp(target.host, target.port);

      const newStatus = reachable ? 'up' : 'down';
      await this.db.query(`UPDATE devices SET status = $2, last_reachability_check_at = now() WHERE id = $1`, [
        device.id,
        newStatus,
      ]);

      if (device.status !== 'up' && newStatus === 'up') {
        this.log.log(`Device ${device.id} transitioned down->up, draining pending changes`);
        try {
          await this.pending.drainForDevice(device.id);
        } catch (err) {
          this.log.warn(`Drain failed for device ${device.id}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }

  private probeTcp(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new Socket();
      const finish = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(PROBE_TIMEOUT_MS);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
      socket.connect(port, host);
    });
  }

  private async probeSnmp(deviceId: number, host: string, port: number): Promise<boolean> {
    const credential = await this.connections.getDecryptedCredential(deviceId, 'snmp_v2c_community');
    return snmpProbeReachable({ host, port: port || 161, community: credential?.secret ?? 'public' });
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue?.close();
  }
}
