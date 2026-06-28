import { Module } from '@nestjs/common';
import { SimulationController } from './simulation.controller';
import { SimulationService } from './simulation.service';
import { SlaModule } from '../sla/sla.module';

@Module({
  imports:     [SlaModule],
  controllers: [SimulationController],
  providers:   [SimulationService],
  exports:     [SimulationService],
})
export class SimulationModule {}
