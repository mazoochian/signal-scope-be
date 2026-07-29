import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';

interface AssetRow {
  serial_number: string; host_name: string | null; model: string | null;
  vendor: string | null; site_name: string | null; rack: string | null;
  os_version: string | null; purchased_at: Date | null;
  warranty_expires_at: Date | null; end_of_support_at: Date | null;
}

@Injectable()
export class InventoryService {
  constructor(private readonly db: DbService) {}

  private async getRows(): Promise<AssetRow[]> {
    const { rows } = await this.db.query<AssetRow>(`
      SELECT
        ia.serial_number, ia.host_name, ia.model, ia.vendor, ia.rack, ia.os_version,
        ia.purchased_at, ia.warranty_expires_at, ia.end_of_support_at,
        s.name AS site_name
      FROM inventory_assets ia
      LEFT JOIN sites s ON s.id = ia.site_id
      ORDER BY ia.id
    `);
    return rows;
  }

  private formatAssets(rows: AssetRow[]) {
    return rows.map((r) => ({
      sn:        r.serial_number,
      host:      r.host_name               ?? '—',
      model:     r.model                   ?? '—',
      vendor:    r.vendor                  ?? '—',
      site:      r.site_name               ?? '—',
      rack:      r.rack                    ?? '—',
      os:        r.os_version              ?? '—',
      purchased: r.purchased_at            ? r.purchased_at.toISOString().slice(0, 10) : '—',
      warranty:  r.warranty_expires_at     ? r.warranty_expires_at.toISOString().slice(0, 10) : '—',
      eos:       r.end_of_support_at       ? r.end_of_support_at.toISOString().slice(0, 10) : '—',
    }));
  }

  /** Derived from the same asset rows the register table shows — no fleet-wide numbers disconnected from the actual inventory. */
  private buildSummary(rows: AssetRow[]) {
    const now = new Date();
    const in90d = new Date(now.getTime() + 90 * 86_400_000);
    const in1yr = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());

    const underWarranty = rows.filter((r) => r.warranty_expires_at && r.warranty_expires_at > now).length;
    const expiring90d   = rows.filter((r) => r.warranty_expires_at && r.warranty_expires_at > now && r.warranty_expires_at <= in90d).length;
    const eosWithin1yr  = rows.filter((r) => r.end_of_support_at && r.end_of_support_at > now && r.end_of_support_at <= in1yr).length;
    const eolUnsupported = rows.filter((r) => r.end_of_support_at && r.end_of_support_at <= now).length;

    return [
      { label: 'Under warranty', value: String(underWarranty),   tone: 'success' },
      { label: 'Expiring 90d',   value: String(expiring90d),     tone: 'warning' },
      { label: 'EoS within 1yr', value: String(eosWithin1yr),    tone: 'warning' },
      { label: 'EoL / unsupported', value: String(eolUnsupported), tone: 'critical' },
    ];
  }

  async getAssets() {
    return this.formatAssets(await this.getRows());
  }

  async getAll() {
    const rows = await this.getRows();
    return { assets: this.formatAssets(rows), summary: this.buildSummary(rows) };
  }
}
