import { Controller, Get, Param, Query } from '@nestjs/common';
import { SimulationService } from './simulation.service';
import { SlaService } from '../sla/sla.service';
import { Permission } from '../auth/guards/permission.decorator';

@Controller('simulation')
export class SimulationController {
  constructor(
    private readonly svc: SimulationService,
    private readonly sla: SlaService,
  ) {}

  @Get('wan')
  @Permission('simulation', 'read')
  getWan(@Query('points') points?: string) {
    return this.svc.getWan(points ? parseInt(points, 10) : 80);
  }

  @Get('kpis')
  @Permission('simulation', 'read')
  async getKpis() {
    const kpis = this.svc.getKpis();
    const compliance = await this.sla.getComplianceSummary().catch(() => null);
    if (compliance && Array.isArray(kpis.stats)) {
      const idx = kpis.stats.findIndex((s: { label?: string }) => s.label?.startsWith('SLA'));
      if (idx !== -1) {
        const allMet = compliance.met === compliance.total;
        kpis.stats[idx] = {
          ...kpis.stats[idx],
          value: `${compliance.pct.toFixed(1)} %`,
          delta: allMet ? 'met' : `${compliance.met}/${compliance.total}`,
          tone:  allMet ? 'up' : compliance.pct >= 50 ? 'warn' : 'down',
        };
      }
    }
    return kpis;
  }

  @Get('snapshot')
  @Permission('simulation', 'read')
  getSnapshot() {
    return this.svc.getSnapshot();
  }

  @Get('device/:id')
  @Permission('simulation', 'read')
  getDevice(@Param('id') id: string, @Query('points') points?: string) {
    return this.svc.getDeviceHistory(id, points ? parseInt(points, 10) : 100);
  }
}
