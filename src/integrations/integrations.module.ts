import { Module } from '@nestjs/common';
import { ReportsModule } from '../reports/reports.module';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { EmailNotificationsService } from './email-notifications.service';

@Module({
  imports: [ReportsModule],
  controllers: [IntegrationsController],
  providers: [IntegrationsService, EmailNotificationsService],
  exports: [IntegrationsService, EmailNotificationsService],
})
export class IntegrationsModule {}
