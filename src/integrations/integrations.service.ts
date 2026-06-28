import { Injectable, OnModuleInit } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { DbService } from '../db/db.service';

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

@Injectable()
export class IntegrationsService implements OnModuleInit {
  constructor(private readonly db: DbService) {}

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

  async getConfig<T>(kind: IntegrationKind): Promise<T | null> {
    const { rows } = await this.db.query<{ config: T }>(
      'SELECT config FROM integration_configs WHERE kind = $1',
      [kind],
    );
    return rows[0]?.config ?? null;
  }

  async saveConfig<T>(kind: IntegrationKind, config: T): Promise<T> {
    await this.db.query(
      `INSERT INTO integration_configs (kind, config, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (kind) DO UPDATE SET config = $2, updated_at = NOW()`,
      [kind, JSON.stringify(config)],
    );
    return config;
  }

  async testEmail(cfg: EmailConfig & { testRecipient?: string }): Promise<void> {
    const port = parseInt(cfg.port, 10) || 587;
    const secure = cfg.security === 'ssl';
    const requireTls = cfg.security === 'starttls';

    const transport = nodemailer.createTransport({
      host: cfg.host,
      port,
      secure,
      requireTLS: requireTls,
      auth: { user: cfg.username, pass: cfg.password },
    });

    await transport.sendMail({
      from: `"${cfg.fromName || 'SignalScope NMS'}" <${cfg.fromAddress || cfg.username}>`,
      to: cfg.testRecipient || cfg.username,
      subject: 'SignalScope — Test Email',
      text: 'This is a test message from SignalScope NMS. Your email integration is working correctly.',
    });
  }

  async testTelegram(cfg: TelegramConfig): Promise<void> {
    const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
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
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.botToken}`,
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
