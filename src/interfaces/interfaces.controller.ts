import { Controller, Get, Query } from '@nestjs/common';
import { InterfacesService } from './interfaces.service';
import { Permission } from '../auth/guards/permission.decorator';

@Controller('interfaces')
export class InterfacesController {
  constructor(private readonly svc: InterfacesService) {}

  @Get()
  @Permission('interfaces', 'read')
  getAll(
    @Query('deviceId') deviceId?: string,
    @Query('q')        q?: string,
    @Query('status')   status?: string,
  ) {
    return this.svc.getAll({
      deviceId: deviceId ? Number(deviceId) : undefined,
      q,
      status,
    });
  }
}
