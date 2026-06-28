import { Controller, Get } from '@nestjs/common';
import { OverviewService } from './overview.service';
import { SimulationService } from '../simulation/simulation.service';
import { SlaService } from '../sla/sla.service';

@Controller('overview')
export class OverviewController {
  constructor(
    private readonly svc: OverviewService,
    private readonly sim: SimulationService,
    private readonly sla: SlaService,
  ) {}

  @Get()
  async getAll() {
    const kpis = this.sim.getKpis();
    const compliance = await this.sla.getComplianceSummary().catch(() => null);

    // Patch the SLA stat with live compliance data
    if (compliance && Array.isArray(kpis.stats)) {
      const slaIdx = kpis.stats.findIndex(
        (s: { label?: string }) => s.label?.startsWith('SLA'),
      );
      if (slaIdx !== -1) {
        const allMet = compliance.met === compliance.total;
        kpis.stats[slaIdx] = {
          ...kpis.stats[slaIdx],
          value: `${compliance.pct.toFixed(1)} %`,
          delta: allMet ? 'met' : `${compliance.met}/${compliance.total}`,
          tone:  allMet ? 'up' : compliance.pct >= 50 ? 'warn' : 'down',
        };
      }
    }

    return this.svc.getAll(kpis.stats, this.sim.getWan());
  }
}
