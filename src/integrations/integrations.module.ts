import { Module } from '@nestjs/common';
import { ReportsModule } from '../reports/reports.module';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { EmailNotificationsService } from './email-notifications.service';
import { CredentialEncryptionService } from '../device-control/crypto/credential-encryption.service';

@Module({
  imports: [ReportsModule],
  controllers: [IntegrationsController],
  // Reuses device-control's CredentialEncryptionService as-is (see
  // AUDIT-REPORT.md H4) — it's a small, stateless-besides-its-key provider
  // (keyed only by CREDENTIAL_ENC_KEY), so it's registered here directly
  // rather than pulling in the rest of DeviceControlModule.
  providers: [IntegrationsService, EmailNotificationsService, CredentialEncryptionService],
  exports: [IntegrationsService, EmailNotificationsService],
})
export class IntegrationsModule {}
