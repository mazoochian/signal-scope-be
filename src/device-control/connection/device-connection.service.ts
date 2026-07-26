import { Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { CredentialEncryptionService } from '../crypto/credential-encryption.service';

export interface ConnectionTarget {
  id: number;
  deviceId: number;
  transport: 'ssh' | 'telnet' | 'snmp';
  host: string;
  port: number;
  kind: 'real' | 'eve-ng' | 'docker-simulator' | 'planned';
  proxyDeviceId: number | null;
  proxySelector: string | null;
}

export interface DeviceIdentity {
  id: number;
  vendorProfileId: string | null;
  connectionKind: string;
  status: string;
}

/**
 * Resolves "how do I actually reach this device" — the piece that makes
 * real/eve-ng/docker-simulator/planned devices feel identical to the rest
 * of the module: everything past this service operates on the same
 * ConnectionTarget shape regardless of which kind it is. A 'planned' ghost
 * device simply has no primary target, which callers treat as
 * "unreachable" (see sync/pending-changes.service.ts), not as an error
 * case requiring special handling.
 */
@Injectable()
export class DeviceConnectionService {
  constructor(
    private readonly db: DbService,
    private readonly crypto: CredentialEncryptionService,
  ) {}

  async getDevice(deviceId: number): Promise<DeviceIdentity> {
    const { rows } = await this.db.query<DeviceIdentity & { vendor_profile_id: string | null; connection_kind: string }>(
      `SELECT id, vendor_profile_id, connection_kind, status FROM devices WHERE id = $1`,
      [deviceId],
    );
    if (!rows[0]) throw new NotFoundException(`Device ${deviceId} not found`);
    return {
      id: rows[0].id,
      vendorProfileId: rows[0].vendor_profile_id,
      connectionKind: rows[0].connection_kind,
      status: rows[0].status,
    };
  }

  async getPrimaryTarget(deviceId: number): Promise<ConnectionTarget | null> {
    const { rows } = await this.db.query<{
      id: number; device_id: number; transport: 'ssh' | 'telnet' | 'snmp'; host: string; port: number;
      kind: ConnectionTarget['kind']; proxy_device_id: number | null; proxy_selector: string | null;
    }>(
      `SELECT id, device_id, transport, host, port, kind, proxy_device_id, proxy_selector
       FROM device_connection_targets WHERE device_id = $1 AND is_primary = true LIMIT 1`,
      [deviceId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      deviceId: row.device_id,
      transport: row.transport,
      host: row.host,
      port: row.port,
      kind: row.kind,
      proxyDeviceId: row.proxy_device_id,
      proxySelector: row.proxy_selector,
    };
  }

  /** Returns the decrypted secret for a given credential kind, or null if none is stored. Never logs the plaintext. */
  async getDecryptedCredential(deviceId: number, kind: string): Promise<{ username: string | null; secret: string; extra: Record<string, unknown> } | null> {
    const { rows } = await this.db.query<{ username: string | null; secret_encrypted: Buffer; extra: Record<string, unknown> }>(
      `SELECT username, secret_encrypted, extra FROM device_credentials
       WHERE device_id = $1 AND kind = $2 AND is_active = true LIMIT 1`,
      [deviceId, kind],
    );
    const row = rows[0];
    if (!row) return null;
    return { username: row.username, secret: this.crypto.decrypt(row.secret_encrypted), extra: row.extra ?? {} };
  }

  async storeCredential(deviceId: number, kind: string, username: string | null, plaintextSecret: string, extra: Record<string, unknown> = {}): Promise<void> {
    const encrypted = this.crypto.encrypt(plaintextSecret);
    await this.db.query(
      `INSERT INTO device_credentials (device_id, kind, username, secret_encrypted, extra, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (device_id, kind, is_active)
       DO UPDATE SET username = EXCLUDED.username, secret_encrypted = EXCLUDED.secret_encrypted,
                     extra = EXCLUDED.extra, rotated_at = now()`,
      [deviceId, kind, username, encrypted, JSON.stringify(extra)],
    );
  }

  async setVendorProfile(deviceId: number, vendorProfileId: string, deviceClass: string): Promise<void> {
    await this.db.query(`UPDATE devices SET vendor_profile_id = $2, device_class = $3 WHERE id = $1`, [
      deviceId,
      vendorProfileId,
      deviceClass,
    ]);
  }

  async setConnectionTarget(deviceId: number, target: {
    transport: 'ssh' | 'telnet' | 'snmp'; host: string; port: number; kind: ConnectionTarget['kind'];
    proxyDeviceId?: number | null; proxySelector?: string | null;
  }): Promise<void> {
    await this.db.query(`UPDATE device_connection_targets SET is_primary = false WHERE device_id = $1`, [deviceId]);
    await this.db.query(
      `INSERT INTO device_connection_targets (device_id, transport, host, port, kind, is_primary, proxy_device_id, proxy_selector)
       VALUES ($1, $2, $3, $4, $5, true, $6, $7)`,
      [deviceId, target.transport, target.host, target.port, target.kind, target.proxyDeviceId ?? null, target.proxySelector ?? null],
    );
    await this.db.query(`UPDATE devices SET connection_kind = $2 WHERE id = $1`, [deviceId, target.kind]);
  }
}
