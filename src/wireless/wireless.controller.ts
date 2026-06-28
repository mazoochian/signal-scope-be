import { Controller, Get } from '@nestjs/common';
import { WirelessService } from './wireless.service';
import { Permission } from '../auth/guards/permission.decorator';

@Controller('wireless')
export class WirelessController {
  constructor(private readonly svc: WirelessService) {}

  @Get()
  @Permission('wireless', 'read')
  getAll() {
    return this.svc.getAll();
  }
}
