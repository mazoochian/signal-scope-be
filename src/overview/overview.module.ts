import { Module } from '@nestjs/common';
import { OverviewController } from './overview.controller';
import { OverviewService } from './overview.service';
import { SimulationModule } from '../simulation/simulation.module';
import { SlaModule } from '../sla/sla.module';

@Module({
  imports:     [SimulationModule, SlaModule],
  controllers: [OverviewController],
  providers:   [OverviewService],
})
export class OverviewModule {}
