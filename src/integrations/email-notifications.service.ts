import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { DbService } from '../db/db.service';
import { IntegrationsService } from './integrations.service';
import { ReportsService } from '../reports/reports.service';

const SEVERITY_ORDER = ['Info', 'Warning', 'Minor', 'Major', 'Critical'];

function severityColor(sev: string): string {
  const map: Record<string, string> = {
    Critical: '#dc2626',
    Major:    '#ea580c',
    Minor:    '#ca8a04',
    Warning:  '#2563eb',
    Info:     '#6b7280',
  };
  return map[sev] ?? '#6b7280';
}

export interface AlertPayload {
  id: string;
  severity: string;
  title: string;
  device: string;
  fired_at: Date;
}

export interface AlertEmailSettings {
  id?: number;
  min_severity: string;
  recipients: { email: string; label?: string }[];
  user_ids: number[];
  enabled: boolean;
}

export interface UserAlertEmailPrefs {
  min_severity: string;
  enabled: boolean;
}

export interface ReportEmailSubscription {
  id?: number;
  label: string;
  report_type: string;
  range: string;
  cron_schedule: string;
  recipients: { email: string; label?: string }[];
  user_ids: number[];
  enabled: boolean;
  last_sent_at?: Date | null;
}

@Injectable()
export class EmailNotificationsService implements OnModuleInit {
  private readonly log = new Logger(EmailNotificationsService.name);

  constructor(
    private readonly db: DbService,
    private readonly integrations: IntegrationsService,
    private readonly reports: ReportsService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  async onModuleInit() {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS alert_email_settings (
        id           SERIAL PRIMARY KEY,
        min_severity TEXT      NOT NULL DEFAULT 'Critical',
        recipients   JSONB     NOT NULL DEFAULT '[]',
        user_ids     INTEGER[] NOT NULL DEFAULT '{}',
        enabled      BOOLEAN   NOT NULL DEFAULT FALSE,
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS user_alert_email_prefs (
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        min_severity TEXT    NOT NULL DEFAULT 'Critical',
        enabled      BOOLEAN NOT NULL DEFAULT FALSE,
        PRIMARY KEY  (user_id)
      )
    `);

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS report_email_subscriptions (
        id            SERIAL PRIMARY KEY,
        label         TEXT      NOT NULL DEFAULT '',
        report_type   TEXT      NOT NULL,
        range         TEXT      NOT NULL DEFAULT '24h',
        cron_schedule TEXT      NOT NULL,
        recipients    JSONB     NOT NULL DEFAULT '[]',
        user_ids      INTEGER[] NOT NULL DEFAULT '{}',
        enabled       BOOLEAN   NOT NULL DEFAULT TRUE,
        last_sent_at  TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await this.bootstrapCronJobs();
  }

  private async bootstrapCronJobs() {
    const { rows } = await this.db.query<ReportEmailSubscription & { id: number }>(
      'SELECT * FROM report_email_subscriptions WHERE enabled = TRUE',
    );
    for (const sub of rows) {
      this.registerReportJob(sub).catch((err: Error) =>
        this.log.warn(`Failed to register report job ${sub.id}: ${err.message}`),
      );
    }
  }

  // ── Alert email settings ────────────────────────────────────────────────────

  async getAlertEmailSettings(): Promise<AlertEmailSettings> {
    const { rows } = await this.db.query<AlertEmailSettings & { id: number }>(
      'SELECT * FROM alert_email_settings LIMIT 1',
    );
    return rows[0] ?? { min_severity: 'Critical', recipients: [], user_ids: [], enabled: false };
  }

  async saveAlertEmailSettings(settings: Omit<AlertEmailSettings, 'id'>): Promise<AlertEmailSettings> {
    const existing = await this.getAlertEmailSettings();
    if (existing.id) {
      await this.db.query(
        `UPDATE alert_email_settings
         SET min_severity=$1, recipients=$2, user_ids=$3, enabled=$4, updated_at=NOW()
         WHERE id=$5`,
        [settings.min_severity, JSON.stringify(settings.recipients), settings.user_ids, settings.enabled, existing.id],
      );
    } else {
      await this.db.query(
        `INSERT INTO alert_email_settings (min_severity, recipients, user_ids, enabled)
         VALUES ($1,$2,$3,$4)`,
        [settings.min_severity, JSON.stringify(settings.recipients), settings.user_ids, settings.enabled],
      );
    }
    return this.getAlertEmailSettings();
  }

  async getUserAlertPrefs(userId: number): Promise<UserAlertEmailPrefs> {
    const { rows } = await this.db.query<UserAlertEmailPrefs>(
      'SELECT min_severity, enabled FROM user_alert_email_prefs WHERE user_id=$1',
      [userId],
    );
    return rows[0] ?? { min_severity: 'Critical', enabled: false };
  }

  async saveUserAlertPrefs(userId: number, prefs: UserAlertEmailPrefs): Promise<UserAlertEmailPrefs> {
    await this.db.query(
      `INSERT INTO user_alert_email_prefs (user_id, min_severity, enabled)
       VALUES ($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET min_severity=$2, enabled=$3`,
      [userId, prefs.min_severity, prefs.enabled],
    );
    return prefs;
  }

  // ── Alert notification ──────────────────────────────────────────────────────

  async notifyAlert(alert: AlertPayload): Promise<void> {
    try {
      const { rows: already } = await this.db.query<{ email_notified_at: Date | null }>(
        'SELECT email_notified_at FROM alerts WHERE id=$1',
        [alert.id],
      );
      if (already[0]?.email_notified_at) return;

      const recipients = await this.resolveAlertRecipients(alert.severity);
      if (!recipients.length) return;

      const subject = `[${alert.severity}] ${alert.title}`;
      const html = this.renderAlertEmail(alert);
      await this.integrations.sendEmail(recipients, subject, html);

      await this.db.query(
        'UPDATE alerts SET email_notified_at=NOW() WHERE id=$1',
        [alert.id],
      );
    } catch (err: any) {
      this.log.warn(`Alert email failed for ${alert.id}: ${err.message}`);
    }
  }

  private async resolveAlertRecipients(severity: string): Promise<string[]> {
    const settings = await this.getAlertEmailSettings();
    if (!settings.enabled) return [];
    if (!this.meetsSeverity(severity, settings.min_severity)) return [];

    const emails = new Set<string>();

    for (const r of settings.recipients) {
      if (r.email) emails.add(r.email);
    }

    if (settings.user_ids?.length) {
      const ids = settings.user_ids;
      const { rows } = await this.db.query<{ email: string }>(
        `SELECT email FROM users WHERE id = ANY($1) AND is_active = TRUE`,
        [ids],
      );
      rows.forEach((r) => emails.add(r.email));
    }

    // Per-user opt-ins
    const { rows: optIns } = await this.db.query<{ email: string; min_severity: string }>(
      `SELECT u.email, p.min_severity
       FROM user_alert_email_prefs p
       JOIN users u ON u.id = p.user_id
       WHERE p.enabled = TRUE AND u.is_active = TRUE`,
    );
    for (const row of optIns) {
      if (this.meetsSeverity(severity, row.min_severity)) {
        emails.add(row.email);
      }
    }

    return [...emails];
  }

  private meetsSeverity(actual: string, minimum: string): boolean {
    return SEVERITY_ORDER.indexOf(actual) >= SEVERITY_ORDER.indexOf(minimum);
  }

  // ── Report subscriptions ────────────────────────────────────────────────────

  async listReportSubscriptions(): Promise<ReportEmailSubscription[]> {
    const { rows } = await this.db.query<ReportEmailSubscription & { id: number }>(
      'SELECT * FROM report_email_subscriptions ORDER BY created_at',
    );
    return rows;
  }

  async createReportSubscription(sub: Omit<ReportEmailSubscription, 'id'>): Promise<ReportEmailSubscription & { id: number }> {
    const { rows } = await this.db.query<ReportEmailSubscription & { id: number }>(
      `INSERT INTO report_email_subscriptions
         (label, report_type, range, cron_schedule, recipients, user_ids, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [sub.label, sub.report_type, sub.range, sub.cron_schedule,
       JSON.stringify(sub.recipients), sub.user_ids, sub.enabled],
    );
    const created = rows[0];
    if (created.enabled) {
      await this.registerReportJob(created);
    }
    return created;
  }

  async updateReportSubscription(id: number, sub: Partial<ReportEmailSubscription>): Promise<ReportEmailSubscription & { id: number }> {
    const { rows } = await this.db.query<ReportEmailSubscription & { id: number }>(
      `UPDATE report_email_subscriptions SET
         label=$1, report_type=$2, range=$3, cron_schedule=$4,
         recipients=$5, user_ids=$6, enabled=$7, updated_at=NOW()
       WHERE id=$8 RETURNING *`,
      [sub.label, sub.report_type, sub.range, sub.cron_schedule,
       JSON.stringify(sub.recipients), sub.user_ids, sub.enabled, id],
    );
    const updated = rows[0];
    this.unregisterReportJob(id);
    if (updated.enabled) {
      await this.registerReportJob(updated);
    }
    return updated;
  }

  async deleteReportSubscription(id: number): Promise<void> {
    this.unregisterReportJob(id);
    await this.db.query('DELETE FROM report_email_subscriptions WHERE id=$1', [id]);
  }

  async sendReportEmailNow(id: number): Promise<void> {
    const { rows } = await this.db.query<ReportEmailSubscription & { id: number }>(
      'SELECT * FROM report_email_subscriptions WHERE id=$1',
      [id],
    );
    if (!rows[0]) throw new Error(`Subscription ${id} not found`);
    await this.sendReportEmail(rows[0]);
  }

  async registerReportJob(sub: ReportEmailSubscription & { id: number }): Promise<void> {
    const name = `report-email-${sub.id}`;
    this.unregisterReportJob(sub.id);

    const job = new CronJob(sub.cron_schedule, () => {
      this.sendReportEmail(sub).catch((err: Error) =>
        this.log.warn(`Report email job ${sub.id} failed: ${err.message}`),
      );
    });

    this.scheduler.addCronJob(name, job);
    job.start();
    this.log.log(`Registered report job ${name} (${sub.cron_schedule})`);
  }

  unregisterReportJob(id: number): void {
    const name = `report-email-${id}`;
    try {
      const job = this.scheduler.getCronJob(name);
      job.stop();
      this.scheduler.deleteCronJob(name);
    } catch {
      // job didn't exist — that's fine
    }
  }

  private async sendReportEmail(sub: ReportEmailSubscription & { id: number }): Promise<void> {
    const range = sub.range as '24h' | '7d' | '30d';
    let data: unknown;
    let title: string;

    switch (sub.report_type) {
      case 'device-health':
        data  = await this.reports.deviceHealth(range);
        title = 'Device Health Report';
        break;
      case 'interface-utilization':
        data  = await this.reports.interfaceUtilization(range);
        title = 'Interface Utilization Report';
        break;
      case 'alert-summary':
        data  = await this.reports.alertSummary(range);
        title = 'Alert Summary Report';
        break;
      case 'availability':
        data  = await this.reports.availability();
        title = 'Availability Report';
        break;
      default:
        throw new Error(`Unknown report type: ${sub.report_type}`);
    }

    const recipients = await this.resolveReportRecipients(sub);
    if (!recipients.length) {
      this.log.warn(`Report subscription ${sub.id} has no recipients — skipping`);
      return;
    }

    const label   = sub.label || title;
    const rangeLabel = sub.range === '24h' ? 'Last 24 Hours' : sub.range === '7d' ? 'Last 7 Days' : 'Last 30 Days';
    const subject = `${label} — ${rangeLabel}`;
    const html    = this.renderReportEmail(title, rangeLabel, sub.report_type, data);

    await this.integrations.sendEmail(recipients, subject, html);
    await this.db.query(
      'UPDATE report_email_subscriptions SET last_sent_at=NOW() WHERE id=$1',
      [sub.id],
    );
    this.log.log(`Sent report email for subscription ${sub.id} to ${recipients.length} recipient(s)`);
  }

  private async resolveReportRecipients(sub: ReportEmailSubscription): Promise<string[]> {
    const emails = new Set<string>();

    for (const r of sub.recipients) {
      if (r.email) emails.add(r.email);
    }

    if (sub.user_ids?.length) {
      const { rows } = await this.db.query<{ email: string }>(
        `SELECT email FROM users WHERE id = ANY($1) AND is_active = TRUE`,
        [sub.user_ids],
      );
      rows.forEach((r) => emails.add(r.email));
    }

    return [...emails];
  }

  // ── HTML email templates ────────────────────────────────────────────────────

  private renderAlertEmail(alert: AlertPayload): string {
    const color  = severityColor(alert.severity);
    const time   = new Date(alert.fired_at).toUTCString();
    const device = alert.device !== '—' ? alert.device : 'N/A';

    return `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;background:#f4f4f5;padding:24px;margin:0">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e4e4e7">
    <div style="background:${color};padding:16px 24px">
      <span style="color:#fff;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.05em">${alert.severity}</span>
      <h2 style="color:#fff;margin:4px 0 0;font-size:18px">${escapeHtml(alert.title)}</h2>
    </div>
    <div style="padding:24px">
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:6px 0;color:#71717a;width:100px">Device</td><td style="padding:6px 0;font-weight:500">${escapeHtml(device)}</td></tr>
        <tr><td style="padding:6px 0;color:#71717a">Severity</td><td style="padding:6px 0;font-weight:500;color:${color}">${alert.severity}</td></tr>
        <tr><td style="padding:6px 0;color:#71717a">Fired at</td><td style="padding:6px 0">${time}</td></tr>
      </table>
      <p style="margin:20px 0 0;font-size:13px;color:#71717a">Log in to SignalScope NMS to acknowledge or investigate this alert.</p>
    </div>
  </div>
</body>
</html>`;
  }

  private renderReportEmail(title: string, rangeLabel: string, type: string, data: unknown): string {
    const body = this.renderReportBody(type, data);
    return `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;background:#f4f4f5;padding:24px;margin:0">
  <div style="max-width:680px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e4e4e7">
    <div style="background:#18181b;padding:16px 24px">
      <span style="color:#a1a1aa;font-size:12px">SignalScope NMS</span>
      <h2 style="color:#fff;margin:4px 0 0;font-size:18px">${escapeHtml(title)}</h2>
      <p style="color:#a1a1aa;margin:4px 0 0;font-size:13px">${escapeHtml(rangeLabel)}</p>
    </div>
    <div style="padding:24px">
      ${body}
    </div>
  </div>
</body>
</html>`;
  }

  private renderReportBody(type: string, data: unknown): string {
    const d = data as any;
    switch (type) {
      case 'device-health':    return this.renderDeviceHealth(d);
      case 'interface-utilization': return this.renderInterfaceUtil(d);
      case 'alert-summary':    return this.renderAlertSummary(d);
      case 'availability':     return this.renderAvailability(d);
      default: return `<pre>${JSON.stringify(data, null, 2)}</pre>`;
    }
  }

  private renderDeviceHealth(d: any): string {
    const { summary, topByCpu } = d;
    return `
      <div style="display:flex;gap:16px;margin-bottom:20px">
        ${statBox('Total', summary.total, '#18181b')}
        ${statBox('Up', summary.up, '#16a34a')}
        ${statBox('Warn', summary.warn, '#ca8a04')}
        ${statBox('Down', summary.down, '#dc2626')}
      </div>
      <h3 style="font-size:14px;margin:0 0 8px">Top Devices by CPU</h3>
      ${tableHtml(['Device', 'Site', 'CPU %', 'Mem %'],
        topByCpu.slice(0, 8).map((r: any) => [r.name, r.site, `${r.cpu}%`, `${r.mem}%`]))}`;
  }

  private renderInterfaceUtil(d: any): string {
    return `
      <h3 style="font-size:14px;margin:0 0 8px">Top Interfaces by Utilization</h3>
      ${tableHtml(['Interface', 'Device', 'Avg In (Mbps)', 'Avg Out (Mbps)', 'Peak In', 'Peak Out'],
        d.interfaces.slice(0, 10).map((r: any) =>
          [r.name, r.device, r.avgIn, r.avgOut, r.peakIn, r.peakOut]))}`;
  }

  private renderAlertSummary(d: any): string {
    const { summary } = d;
    return `
      <div style="display:flex;gap:16px;margin-bottom:20px">
        ${statBox('Total', summary.total, '#18181b')}
        ${statBox('Critical', summary.critical, '#dc2626')}
        ${statBox('Major', summary.major, '#ea580c')}
        ${statBox('Minor', summary.minor, '#ca8a04')}
      </div>
      <h3 style="font-size:14px;margin:0 0 8px">Alerts by Severity</h3>
      ${tableHtml(['Severity', 'Count'],
        d.bySeverity.map((r: any) => [r.severity, r.count]))}
      <h3 style="font-size:14px;margin:16px 0 8px">Top Alerting Devices</h3>
      ${tableHtml(['Device', 'Alert Count'],
        d.topDevices.slice(0, 8).map((r: any) => [r.name, r.alertCount]))}`;
  }

  private renderAvailability(d: any): string {
    return `
      <h3 style="font-size:14px;margin:0 0 8px">Device Availability</h3>
      ${tableHtml(['Device', 'Site', 'Status', 'Availability'],
        d.devices.slice(0, 15).map((r: any) => [r.name, r.site, r.status, `${r.availability}%`]))}`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statBox(label: string, value: number, color: string): string {
  return `<div style="flex:1;background:#f4f4f5;border-radius:6px;padding:12px;text-align:center">
    <div style="font-size:24px;font-weight:700;color:${color}">${value}</div>
    <div style="font-size:12px;color:#71717a;margin-top:2px">${label}</div>
  </div>`;
}

function tableHtml(headers: string[], rows: unknown[][]): string {
  const th = headers.map((h) => `<th style="padding:6px 10px;text-align:left;background:#f4f4f5;font-size:12px;font-weight:600;color:#52525b">${h}</th>`).join('');
  const trs = rows.map((row) =>
    `<tr>${row.map((cell) => `<td style="padding:6px 10px;font-size:13px;border-top:1px solid #f4f4f5">${escapeHtml(String(cell ?? '—'))}</td>`).join('')}</tr>`,
  ).join('');
  return `<table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr>${th}</tr></thead>
    <tbody>${trs || '<tr><td colspan="99" style="padding:10px;color:#71717a;font-size:13px">No data</td></tr>'}</tbody>
  </table>`;
}
