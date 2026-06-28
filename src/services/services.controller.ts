import { Controller, Get } from '@nestjs/common';
import { ServicesService } from './services.service';
import { Permission } from '../auth/guards/permission.decorator';

@Controller('services')
export class ServicesController {
  constructor(private readonly svc: ServicesService) {}

  @Get()
  @Permission('services', 'read')
  getAll() {
    return this.svc.getAll();
  }
}
