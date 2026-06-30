import { Controller, Get, Post, Delete, Body, Param, NotFoundException } from '@nestjs/common';
import { DevicesService, CreateDeviceDto } from './devices.service';
import { Permission } from '../auth/guards/permission.decorator';

@Controller('devices')
export class DevicesController {
  constructor(private readonly svc: DevicesService) {}

  @Get()
  @Permission('devices', 'read')
  getAll() {
    return this.svc.getAll();
  }

  @Post()
  @Permission('devices', 'write')
  create(@Body() dto: CreateDeviceDto) {
    return this.svc.create(dto);
  }

  @Delete(':id')
  @Permission('devices', 'delete')
  remove(@Param('id') id: string) {
    const deleted = this.svc.delete(Number(id));
    if (!deleted) throw new NotFoundException('Device not found');
    return { deleted: true };
  }
}
