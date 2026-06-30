import { Controller, Get } from '@nestjs/common';
import { DiscoveryService } from './discovery.service';
import { Permission } from '../auth/guards/permission.decorator';

@Controller('discovery')
export class DiscoveryController {
  constructor(private readonly svc: DiscoveryService) {}

  @Get()
  @Permission('discovery', 'read')
  getAll() {
    return this.svc.getAll();
  }
}
