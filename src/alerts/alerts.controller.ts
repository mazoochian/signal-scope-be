import { Controller, Get, Param, Patch } from '@nestjs/common';
import { AlertsService } from './alerts.service';
import { Permission } from '../auth/guards/permission.decorator';

@Controller('alerts')
export class AlertsController {
  constructor(private readonly svc: AlertsService) {}

  @Get()
  @Permission('alerts', 'read')
  getAll() {
    return this.svc.getAll();
  }

  @Get('stats')
  @Permission('alerts', 'read')
  getStats() {
    return this.svc.getStats();
  }

  @Get('device/:name')
  @Permission('alerts', 'read')
  getByDevice(@Param('name') name: string) {
    return this.svc.getAlertsByDevice(name);
  }

  @Patch(':id/acknowledge')
  @Permission('alerts', 'execute')
  acknowledge(@Param('id') id: string) {
    return this.svc.acknowledge(id);
  }

  @Patch(':id/suppress')
  @Permission('alerts', 'execute')
  suppress(@Param('id') id: string) {
    return this.svc.suppress(id);
  }
}
