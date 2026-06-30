import { Controller, Get } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { Permission } from '../auth/guards/permission.decorator';

@Controller('inventory')
export class InventoryController {
  constructor(private readonly svc: InventoryService) {}

  @Get()
  @Permission('inventory', 'read')
  getAll() {
    return this.svc.getAll();
  }
}
