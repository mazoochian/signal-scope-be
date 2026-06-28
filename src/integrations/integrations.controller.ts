import {
  Body, Controller, Get, HttpCode, Post, Put, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/guards/roles.decorator';
import {
  IntegrationsService,
  EmailConfig,
  TelegramConfig,
  SlackConfig,
} from './integrations.service';

@Controller('integrations')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class IntegrationsController {
  constructor(private readonly svc: IntegrationsService) {}

  // ── Email ────────────────────────────────────────────────────────────────

  @Get('email')
  getEmail() {
    return this.svc.getConfig<EmailConfig>('email');
  }

  @Put('email')
  saveEmail(@Body() body: EmailConfig) {
    return this.svc.saveConfig('email', body);
  }

  @Post('email/test')
  @HttpCode(200)
  async testEmail(@Body() body: EmailConfig & { testRecipient?: string }) {
    await this.svc.testEmail(body);
    return { ok: true };
  }

  // ── Telegram ──────────────────────────────────────────────────────────────

  @Get('telegram')
  getTelegram() {
    return this.svc.getConfig<TelegramConfig>('telegram');
  }

  @Put('telegram')
  saveTelegram(@Body() body: TelegramConfig) {
    return this.svc.saveConfig('telegram', body);
  }

  @Post('telegram/test')
  @HttpCode(200)
  async testTelegram(@Body() body: TelegramConfig) {
    await this.svc.testTelegram(body);
    return { ok: true };
  }

  // ── Slack ─────────────────────────────────────────────────────────────────

  @Get('slack')
  getSlack() {
    return this.svc.getConfig<SlackConfig>('slack');
  }

  @Put('slack')
  saveSlack(@Body() body: SlackConfig) {
    return this.svc.saveConfig('slack', body);
  }

  @Post('slack/test')
  @HttpCode(200)
  async testSlack(@Body() body: SlackConfig) {
    await this.svc.testSlack(body);
    return { ok: true };
  }
}
