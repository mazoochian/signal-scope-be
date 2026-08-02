import { Injectable, OnModuleInit } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { DbService } from '../db/db.service';
import { CredentialEncryptionService } from '../device-control/crypto/credential-encryption.service';

/**
 * Sentinel returned in place of a real secret on any read, and treated as
 * "leave the stored secret unchanged" on write. Never the actual secret
 * value goes over the wire in either direction once it's been saved once.
 * This exact string is a fixed contract shared with signal-scope-fe (see
 * AUDIT-REPORT.md H4) — do not change it without updating the frontend too.
 */
export const SECRET_SENTINEL = '********';

export interface EmailConfig {
  enabled: boolean;
  host: string;
  port: string;
  security: 'starttls' | 'ssl' | 'none';
  username: string;
  password: string;
  fromName: string;
  fromAddress: string;
}

export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  defaultChatId: string;
}

export interface SlackConfig {
  enabled: boolean;
  botToken: string;
  defaultChannel: string;
}

type IntegrationKind = 'email' | 'telegram' | 'slack';

// Which field in each kind's config blob holds a secret that must be
// encrypted at rest and never returned in plaintext.
const SECRET_FIELD: Record<IntegrationKind, string | null> = {
  email: 'password',
  telegram: 'botToken',
  slack: 'botToken',
};

@Injectable()
export class IntegrationsService implements OnModuleInit {
  constructor(
    private readonly db: DbService,
    private readonly crypto: CredentialEncryptionService,
  ) {}

  async onModuleInit() {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS integration_configs (
        id         SERIAL PRIMARY KEY,
        kind       TEXT NOT NULL UNIQUE CHECK (kind IN ('email', 'telegram', 'slack')),
        config     JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  /** Raw stored config, secret field still encrypted (base64) — internal use only, never return this to a client. */
  private async getRawConfig<T extends Record<string, any>>(kind: IntegrationKind): Promise<T | null> {
    const { rows } = await this.db.query<{ config: T }>(
      'SELECT config FROM integration_configs WHERE kind = $1',
      [kind],
    );
    return rows[0]?.config ?? null;
  }

  /** Client-facing read: the secret field, if set, is replaced with SECRET_SENTINEL — never the real value (AUDIT-REPORT.md H4). */
  async getConfig<T extends Record<string, any>>(kind: IntegrationKind): Promise<T | null> {
    const raw = await this.getRawConfig<T>(kind);
    if (!raw) return null;
    return this.mask(kind, raw);
  }

  /** Server-side use only (e.g. actually sending an email) — decrypts the secret field. Never expose this over the API. */
  async getDecryptedConfig<T extends Record<string, any>>(kind: IntegrationKind): Promise<T | null> {
    const raw = await this.getRawConfig<T>(kind);
    if (!raw) return null;
    const field = SECRET_FIELD[kind];
    if (!field || !raw[field]) return raw;
    return { ...raw, [field]: this.crypto.decrypt(Buffer.from(raw[field], 'base64')) };
  }

  async saveConfig<T extends Record<string, any>>(kind: IntegrationKind, incoming: T): Promise<T> {
    const field = SECRET_FIELD[kind];
    const toStore: Record<string, any> = { ...incoming };

    if (field) {
      const incomingSecret = incoming[field];
      if (incomingSecret === SECRET_SENTINEL) {
        // Unchanged: the client never gets the real secret back, so seeing
        // the sentinel means "the form field was untouched" — keep whatever
        // is already stored (still encrypted) rather than overwriting it
        // with the literal sentinel string.
        const existing = await this.getRawConfig<T>(kind);
        toStore[field] = existing ? (existing as any)[field] ?? null : null;
      } else if (incomingSecret) {
        toStore[field] = this.crypto.encrypt(String(incomingSecret)).toString('base64');
      } else {
        toStore[field] = null;
      }
    }

    await this.db.query(
      `INSERT INTO integration_configs (kind, config, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (kind) DO UPDATE SET config = $2, updated_at = NOW()`,
      [kind, JSON.stringify(toStore)],
    );
    return this.mask(kind, toStore as T);
  }

  /** Resolves a value coming from a client-supplied config for immediate use (e.g. the "test" endpoints): the sentinel means "use the already-stored secret", anything else is a fresh plaintext value the client just typed in. */
  private async resolveSecret(kind: IntegrationKind, incoming: string | undefined | null): Promise<string> {
    const field = SECRET_FIELD[kind];
    if (incoming === SECRET_SENTINEL) {
      const existing = field ? await this.getRawConfig<Record<string, any>>(kind) : null;
      const stored = existing && field ? existing[field] : null;
      if (!stored) throw new Error(`No secret is currently stored for ${kind}; enter one before testing`);
      return this.crypto.decrypt(Buffer.from(stored, 'base64'));
    }
    return incoming ?? '';
  }

  private mask<T extends Record<string, any>>(kind: IntegrationKind, config: T): T {
    const field = SECRET_FIELD[kind];
    if (!field) return config;
    const value = (config as any)[field];
    return { ...config, [field]: value ? SECRET_SENTINEL : null };
  }

  private buildTransport(cfg: EmailConfig) {
    const port = parseInt(cfg.port, 10) || 587;
    return nodemailer.createTransport({
      host: cfg.host,
      port,
      secure: cfg.security === 'ssl',
      requireTLS: cfg.security === 'starttls',
      auth: { user: cfg.username, pass: cfg.password },
    });
  }

  async sendEmail(to: string[], subject: string, html: string): Promise<void> {
    // Decrypted config for actual sending — getConfig() would return the
    // masked "********" sentinel, which is not a usable SMTP password.
    const cfg = await this.getDecryptedConfig<EmailConfig>('email');
    if (!cfg?.enabled) throw new Error('Email integration is not enabled');
    if (!cfg.host) throw new Error('Email SMTP host is not configured');

    const transport = this.buildTransport(cfg);
    await transport.sendMail({
      from: `"${cfg.fromName || 'SignalScope NMS'}" <${cfg.fromAddress || cfg.username}>`,
      to: to.join(', '),
      subject,
      html,
    });
  }

  async testEmail(cfg: EmailConfig & { testRecipient?: string }): Promise<void> {
    // cfg.password may be the "********" sentinel (user is testing an
    // already-saved config without retyping the password) or a fresh
    // plaintext value — resolveSecret() sorts that out.
    const password = await this.resolveSecret('email', cfg.password);
    const transport = this.buildTransport({ ...cfg, password });
    await transport.sendMail({
      from: `"${cfg.fromName || 'SignalScope NMS'}" <${cfg.fromAddress || cfg.username}>`,
      to: cfg.testRecipient || cfg.username,
      subject: 'SignalScope — Test Email',
      text: 'This is a test message from SignalScope NMS. Your email integration is working correctly.',
    });
  }

  async testTelegram(cfg: TelegramConfig): Promise<void> {
    const botToken = await this.resolveSecret('telegram', cfg.botToken);
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.defaultChatId,
        text: '✅ *SignalScope NMS* — Test message\\. Your Telegram integration is working correctly\\.',
        parse_mode: 'MarkdownV2',
      }),
    });
    if (!res.ok) {
      const body = (await res.json()) as { description?: string };
      throw new Error(body.description ?? `Telegram API error ${res.status}`);
    }
  }

  async testSlack(cfg: SlackConfig): Promise<void> {
    const botToken = await this.resolveSecret('slack', cfg.botToken);
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({
        channel: cfg.defaultChannel,
        text: ':white_check_mark: *SignalScope NMS* — Test message. Your Slack integration is working correctly.',
      }),
    });
    const body = (await res.json()) as { ok: boolean; error?: string };
    if (!body.ok) throw new Error(body.error ?? 'Slack API error');
  }
}
