import { Controller, Get, Query } from '@nestjs/common';
import { InterfacesService } from './interfaces.service';

@Controller('interfaces')
export class InterfacesController {
  constructor(private readonly svc: InterfacesService) {}

  @Get()
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
