import { Controller, Get } from '@nestjs/common';
import { TopologyService } from './topology.service';
import { Permission } from '../auth/guards/permission.decorator';

@Controller('topology')
export class TopologyController {
  constructor(private readonly svc: TopologyService) {}

  @Get()
  @Permission('topology', 'read')
  getAll() {
    return this.svc.getAll();
  }
}
