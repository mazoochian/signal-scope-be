import { Controller, Get, Param, Patch } from '@nestjs/common';
import { AlertsService } from './alerts.service';

@Controller('alerts')
export class AlertsController {
  constructor(private readonly svc: AlertsService) {}

  @Get()
  getAll() {
    return this.svc.getAll();
  }

  @Get('stats')
  getStats() {
    return this.svc.getStats();
  }

  @Get('device/:name')
  getByDevice(@Param('name') name: string) {
    return this.svc.getAlertsByDevice(name);
  }

  @Patch(':id/acknowledge')
  acknowledge(@Param('id') id: string) {
    return this.svc.acknowledge(id);
  }

  @Patch(':id/suppress')
  suppress(@Param('id') id: string) {
    return this.svc.suppress(id);
  }
}
