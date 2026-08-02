import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Req,
} from '@nestjs/common';
import { Request } from 'express';
import {
  IntegrationsService,
  EmailConfig,
  TelegramConfig,
  SlackConfig,
} from './integrations.service';
import {
  EmailNotificationsService,
  AlertEmailSettings,
  UserAlertEmailPrefs,
  ReportEmailSubscription,
} from './email-notifications.service';
import { Permission } from '../auth/guards/permission.decorator';
import { EmailConfigDto, SlackConfigDto, TelegramConfigDto, TestEmailConfigDto } from './dto/integration-config.dto';
import {
  AlertEmailSettingsDto,
  CreateReportSubscriptionDto,
  UpdateReportSubscriptionDto,
  UserAlertEmailPrefsDto,
} from './dto/email-notification.dto';

@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly svc: IntegrationsService,
    private readonly emailNotifications: EmailNotificationsService,
  ) {}

  @Get('email')
  @Permission('integrations', 'read')
  getEmail() { return this.svc.getConfig<EmailConfig>('email'); }

  @Put('email')
  @Permission('integrations', 'write')
  saveEmail(@Body() body: EmailConfigDto) { return this.svc.saveConfig('email', body); }

  @Post('email/test')
  @Permission('integrations', 'execute')
  @HttpCode(200)
  async testEmail(@Body() body: TestEmailConfigDto) {
    await this.svc.testEmail(body);
    return { ok: true };
  }

  @Get('telegram')
  @Permission('integrations', 'read')
  getTelegram() { return this.svc.getConfig<TelegramConfig>('telegram'); }

  @Put('telegram')
  @Permission('integrations', 'write')
  saveTelegram(@Body() body: TelegramConfigDto) { return this.svc.saveConfig('telegram', body); }

  @Post('telegram/test')
  @Permission('integrations', 'execute')
  @HttpCode(200)
  async testTelegram(@Body() body: TelegramConfigDto) {
    await this.svc.testTelegram(body);
    return { ok: true };
  }

  @Get('slack')
  @Permission('integrations', 'read')
  getSlack() { return this.svc.getConfig<SlackConfig>('slack'); }

  @Put('slack')
  @Permission('integrations', 'write')
  saveSlack(@Body() body: SlackConfigDto) { return this.svc.saveConfig('slack', body); }

  @Post('slack/test')
  @Permission('integrations', 'execute')
  @HttpCode(200)
  async testSlack(@Body() body: SlackConfigDto) {
    await this.svc.testSlack(body);
    return { ok: true };
  }

  // ── Alert email settings ──────────────────────────────────────────────────

  @Get('email/alert-settings')
  @Permission('integrations', 'read')
  getAlertSettings() {
    return this.emailNotifications.getAlertEmailSettings();
  }

  @Put('email/alert-settings')
  @Permission('integrations', 'write')
  saveAlertSettings(@Body() body: AlertEmailSettingsDto) {
    return this.emailNotifications.saveAlertEmailSettings(body);
  }

  @Get('email/alert-settings/my-prefs')
  getMyAlertPrefs(@Req() req: Request) {
    const me = (req as any).user;
    return this.emailNotifications.getUserAlertPrefs(me.id);
  }

  @Put('email/alert-settings/my-prefs')
  @HttpCode(200)
  saveMyAlertPrefs(@Body() body: UserAlertEmailPrefsDto, @Req() req: Request) {
    const me = (req as any).user;
    return this.emailNotifications.saveUserAlertPrefs(me.id, body);
  }

  // ── Report subscriptions ──────────────────────────────────────────────────

  @Get('email/report-subscriptions')
  @Permission('integrations', 'read')
  listReportSubscriptions() {
    return this.emailNotifications.listReportSubscriptions();
  }

  @Post('email/report-subscriptions')
  @Permission('integrations', 'write')
  createReportSubscription(@Body() body: CreateReportSubscriptionDto) {
    return this.emailNotifications.createReportSubscription(body);
  }

  @Put('email/report-subscriptions/:id')
  @Permission('integrations', 'write')
  updateReportSubscription(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateReportSubscriptionDto,
  ) {
    return this.emailNotifications.updateReportSubscription(id, body);
  }

  @Delete('email/report-subscriptions/:id')
  @Permission('integrations', 'delete')
  @HttpCode(200)
  async deleteReportSubscription(@Param('id', ParseIntPipe) id: number) {
    await this.emailNotifications.deleteReportSubscription(id);
    return { ok: true };
  }

  @Post('email/report-subscriptions/:id/send-now')
  @Permission('integrations', 'execute')
  @HttpCode(200)
  async sendReportNow(@Param('id', ParseIntPipe) id: number) {
    await this.emailNotifications.sendReportEmailNow(id);
    return { ok: true };
  }
}
