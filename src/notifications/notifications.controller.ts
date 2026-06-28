import { Controller, Get, Param, Patch, Post, ParseIntPipe } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { Permission } from '../auth/guards/permission.decorator';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get()
  @Permission('notifications', 'read')
  getAll() {
    return this.svc.getAll();
  }

  @Patch(':id/read')
  @Permission('notifications', 'execute')
  markRead(@Param('id', ParseIntPipe) id: number) {
    return this.svc.markRead(id);
  }

  @Post('mark-all-read')
  @Permission('notifications', 'execute')
  markAllRead() {
    return this.svc.markAllRead();
  }
}
