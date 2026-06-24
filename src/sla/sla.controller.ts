import { Controller, Get, Post, Put, Delete, Body, Param } from '@nestjs/common';
import { SlaService } from './sla.service';

@Controller('sla')
export class SlaController {
  constructor(private readonly svc: SlaService) {}

  @Get('parameters')
  list() { return this.svc.list(); }

  @Post('parameters')
  create(@Body() dto: any) { return this.svc.create(dto); }

  @Put('parameters/:id')
  update(@Param('id') id: string, @Body() dto: any) {
    return this.svc.update(Number(id), dto);
  }

  @Delete('parameters/:id')
  async remove(@Param('id') id: string) {
    const ok = await this.svc.remove(Number(id));
    return { deleted: ok };
  }

  @Get('status')
  status() { return this.svc.getStatus(); }
}
