import { Controller, Get, Post, Put, Delete, Body, Param } from '@nestjs/common';
import { SlaService } from './sla.service';
import { Permission } from '../auth/guards/permission.decorator';

@Controller('sla')
export class SlaController {
  constructor(private readonly svc: SlaService) {}

  @Get('parameters')
  @Permission('sla', 'read')
  list() { return this.svc.list(); }

  @Post('parameters')
  @Permission('sla', 'write')
  create(@Body() dto: any) { return this.svc.create(dto); }

  @Put('parameters/:id')
  @Permission('sla', 'write')
  update(@Param('id') id: string, @Body() dto: any) {
    return this.svc.update(Number(id), dto);
  }

  @Delete('parameters/:id')
  @Permission('sla', 'delete')
  async remove(@Param('id') id: string) {
    const ok = await this.svc.remove(Number(id));
    return { deleted: ok };
  }

  @Get('status')
  @Permission('sla', 'read')
  status() { return this.svc.getStatus(); }
}
