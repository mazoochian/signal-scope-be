import { Controller, Get, Param, Query } from '@nestjs/common';
import { ReportsService } from './reports.service';

type Range = '24h' | '7d' | '30d';

@Controller('reports')
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  @Get('data/:type')
  getData(
    @Param('type') type: string,
    @Query('range') range: string = '7d',
  ) {
    const r = (['24h', '7d', '30d'].includes(range) ? range : '7d') as Range;
    switch (type) {
      case 'device-health':       return this.svc.deviceHealth(r);
      case 'interface-utilization': return this.svc.interfaceUtilization(r);
      case 'alert-summary':       return this.svc.alertSummary(r);
      case 'availability':        return this.svc.availability();
      default: return { error: 'Unknown report type' };
    }
  }
}
