import { Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { DeviceActionKind } from '../adapters/vendor-adapter.interface';

/** Maps a DeviceAction kind to the capability_key namespace used in device_capabilities/vendor_capability_defaults. */
const SNMP_CAPABILITY_KEY: Partial<Record<DeviceActionKind, string>> = {
  'port.setAdminStatus': 'snmp.write.port_admin_status',
  'port.setDescription': 'snmp.write.port_description',
  'vlan.setPvid': 'snmp.write.vlan_pvid',
  'vlan.setTrunkAllowed': 'snmp.write.vlan_trunk_allowed',
  'config.save': 'snmp.write.config_save',
};

interface CapabilityRow {
  capability_value: { supported?: boolean; [k: string]: unknown };
  confidence: 'confirmed' | 'assumed' | 'unknown';
}

/**
 * The structured, queryable version of signal-scope-docs/comparison/
 * snmp-write-support-matrix.md — this is what lets device-action.processor.ts
 * check "does an SNMP-SET fallback exist here" before attempting one,
 * per gui-cli-snmp-unification.md's standing rule: never assume SNMP SET
 * as a universal fallback.
 */
@Injectable()
export class CapabilityRegistryService {
  constructor(private readonly db: DbService) {}

  /**
   * Copies vendor_capability_defaults into per-device device_capabilities
   * — the device's starting point, which can later diverge as live probes
   * confirm/override specific objects (data-model-notes.md gap #2: support
   * can depend on firmware/license, not just vendor).
   */
  async seedFromVendorDefaults(deviceId: number, vendorProfileId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO device_capabilities (device_id, capability_key, capability_value, confidence, source)
       SELECT $1, capability_key, capability_value, confidence, source
       FROM vendor_capability_defaults
       WHERE vendor_profile_id = $2
       ON CONFLICT (device_id, capability_key) DO NOTHING`,
      [deviceId, vendorProfileId],
    );
  }

  async supportsSnmpWrite(deviceId: number, actionKind: DeviceActionKind): Promise<boolean> {
    const key = SNMP_CAPABILITY_KEY[actionKind];
    if (!key) return false; // no capability mapping known for this action at all -> never attempt SNMP

    const { rows } = await this.db.query<CapabilityRow>(
      `SELECT capability_value, confidence FROM device_capabilities WHERE device_id = $1 AND capability_key = $2`,
      [deviceId, key],
    );
    const row = rows[0];
    if (!row) return false; // unknown -> CLI-only, per the docs tree's default posture
    return row.capability_value?.supported === true && row.confidence !== 'unknown';
  }

  async getCapability(deviceId: number, capabilityKey: string) {
    const { rows } = await this.db.query<CapabilityRow>(
      `SELECT capability_value, confidence FROM device_capabilities WHERE device_id = $1 AND capability_key = $2`,
      [deviceId, capabilityKey],
    );
    return rows[0] ?? null;
  }
}
