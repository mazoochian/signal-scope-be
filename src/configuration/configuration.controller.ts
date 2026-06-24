import {
  Controller, Get, Post, Param, ParseIntPipe, Query, Body
} from '@nestjs/common';
import { ConfigurationService } from './configuration.service';

@Controller('configuration')
export class ConfigurationController {
  constructor(private readonly svc: ConfigurationService) {}

  @Get('devices')
  listDevices() {
    return this.svc.listDeviceSummaries();
  }

  @Get('devices/:id/config')
  getCurrentConfig(@Param('id', ParseIntPipe) id: number) {
    return this.svc.getCurrentConfig(id);
  }

  @Get('devices/:id/config/:version')
  getVersion(
    @Param('id', ParseIntPipe) id: number,
    @Param('version', ParseIntPipe) version: number,
  ) {
    return this.svc.getConfigVersion(id, version);
  }

  @Get('devices/:id/history')
  listVersions(@Param('id', ParseIntPipe) id: number) {
    return this.svc.listVersions(id);
  }

  @Post('devices/:id/snapshot')
  takeSnapshot(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { committedBy?: string; notes?: string },
  ) {
    return this.svc.takeSnapshot(id, body.committedBy, body.notes);
  }

  @Post('snapshot-all')
  snapshotAll() {
    return this.svc.snapshotAll();
  }
}
