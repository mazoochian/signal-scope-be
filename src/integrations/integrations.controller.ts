import {
  Body, Controller, Get, HttpCode, Post, Put,
} from '@nestjs/common';
import {
  IntegrationsService,
  EmailConfig,
  TelegramConfig,
  SlackConfig,
} from './integrations.service';
import { Permission } from '../auth/guards/permission.decorator';

@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly svc: IntegrationsService) {}

  @Get('email')
  @Permission('integrations', 'read')
  getEmail() { return this.svc.getConfig<EmailConfig>('email'); }

  @Put('email')
  @Permission('integrations', 'write')
  saveEmail(@Body() body: EmailConfig) { return this.svc.saveConfig('email', body); }

  @Post('email/test')
  @Permission('integrations', 'execute')
  @HttpCode(200)
  async testEmail(@Body() body: EmailConfig & { testRecipient?: string }) {
    await this.svc.testEmail(body);
    return { ok: true };
  }

  @Get('telegram')
  @Permission('integrations', 'read')
  getTelegram() { return this.svc.getConfig<TelegramConfig>('telegram'); }

  @Put('telegram')
  @Permission('integrations', 'write')
  saveTelegram(@Body() body: TelegramConfig) { return this.svc.saveConfig('telegram', body); }

  @Post('telegram/test')
  @Permission('integrations', 'execute')
  @HttpCode(200)
  async testTelegram(@Body() body: TelegramConfig) {
    await this.svc.testTelegram(body);
    return { ok: true };
  }

  @Get('slack')
  @Permission('integrations', 'read')
  getSlack() { return this.svc.getConfig<SlackConfig>('slack'); }

  @Put('slack')
  @Permission('integrations', 'write')
  saveSlack(@Body() body: SlackConfig) { return this.svc.saveConfig('slack', body); }

  @Post('slack/test')
  @Permission('integrations', 'execute')
  @HttpCode(200)
  async testSlack(@Body() body: SlackConfig) {
    await this.svc.testSlack(body);
    return { ok: true };
  }
}
