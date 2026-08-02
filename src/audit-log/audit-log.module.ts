import { Global, Module } from '@nestjs/common';
import { AuditLogController } from './audit-log.controller';
import { AuditLogService } from './audit-log.service';

// @Global() so any module can inject AuditLogService without listing
// AuditLogModule in its own `imports` — matches DbModule's pattern
// (src/db/db.module.ts), since audit recording is a cross-cutting
// concern called from auth, users, and integrations.
@Global()
@Module({
  controllers: [AuditLogController],
  providers: [AuditLogService],
  exports: [AuditLogService],
})
export class AuditLogModule {}
