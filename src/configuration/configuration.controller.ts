import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ConfigurationService } from './configuration.service';
import { Permission } from '../auth/guards/permission.decorator';

@Controller('configuration')
export class ConfigurationController {
  constructor(private readonly svc: ConfigurationService) {}

  @Get('devices')
  @Permission('configuration', 'read')
  listDevices() {
    return this.svc.listDeviceSummaries();
  }

  @Get('devices/:id/config')
  @Permission('configuration', 'read')
  getCurrentConfig(@Param('id', ParseIntPipe) id: number) {
    return this.svc.getCurrentConfig(id);
  }

  @Get('devices/:id/config/:version')
  @Permission('configuration', 'read')
  getVersion(
    @Param('id', ParseIntPipe) id: number,
    @Param('version', ParseIntPipe) version: number,
  ) {
    return this.svc.getConfigVersion(id, version);
  }

  @Get('devices/:id/history')
  @Permission('configuration', 'read')
  listVersions(@Param('id', ParseIntPipe) id: number) {
    return this.svc.listVersions(id);
  }

  @Post('devices/:id/snapshot')
  @Permission('configuration', 'execute')
  takeSnapshot(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { committedBy?: string; notes?: string },
  ) {
    return this.svc.takeSnapshot(id, body.committedBy, body.notes);
  }

  @Post('snapshot-all')
  @Permission('configuration', 'execute')
  snapshotAll() {
    return this.svc.snapshotAll();
  }
}
