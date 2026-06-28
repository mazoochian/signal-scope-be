import { Controller, Get } from '@nestjs/common';
import { TelemetryService } from './telemetry.service';
import { Permission } from '../auth/guards/permission.decorator';

@Controller('telemetry')
export class TelemetryController {
  constructor(private readonly svc: TelemetryService) {}

  @Get()
  @Permission('telemetry', 'read')
  getAll() {
    return this.svc.getAll();
  }
}
