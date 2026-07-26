import IORedis from 'ioredis';

let connection: IORedis | null = null;

/**
 * Shared ioredis connection for BullMQ. maxRetriesPerRequest: null is
 * required by BullMQ (it manages its own retry/backoff semantics on top of
 * a connection that never gives up).
 */
export function getRedisConnection(): IORedis {
  if (!connection) {
    connection = new IORedis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
      maxRetriesPerRequest: null,
    });
  }
  return connection;
}

/** Test-only: closes the shared connection so integration tests (which boot/tear down a full app context per suite) don't leave a dangling handle open past the suite's lifetime. */
export async function closeRedisConnection(): Promise<void> {
  if (connection) {
    await connection.quit();
    connection = null;
  }
}
