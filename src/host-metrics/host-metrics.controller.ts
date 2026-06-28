import { Controller, Get } from '@nestjs/common';
import { HostMetricsService } from './host-metrics.service';
import { Permission } from '../auth/guards/permission.decorator';

@Controller('host-metrics')
export class HostMetricsController {
  constructor(private readonly svc: HostMetricsService) {}

  @Get()
  @Permission('dashboard', 'read')
  getMetrics() {
    return this.svc.getMetrics();
  }
}
