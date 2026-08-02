import { Controller, Get, Query } from '@nestjs/common';
import { AuditLogService } from './audit-log.service';
import { Permission } from '../auth/guards/permission.decorator';

@Controller('audit-log')
export class AuditLogController {
  constructor(private readonly svc: AuditLogService) {}

  @Get()
  @Permission('audit', 'read')
  list(@Query('limit') limit?: string) {
    return this.svc.list(limit ? Number(limit) : undefined);
  }
}
