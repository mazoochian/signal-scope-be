import {
  Controller, ForbiddenException, Get, HttpCode, Post, Req,
} from '@nestjs/common';
import { Request } from 'express';
import { PermissionsService } from './permissions.service';

@Controller('permissions')
export class PermissionsController {
  constructor(private readonly permissionsService: PermissionsService) {}

  @Get()
  getMatrix(@Req() req: Request) {
    const user = (req as any).user;
    if (!user || !['superadmin', 'admin'].includes(user.role)) {
      throw new ForbiddenException();
    }
    return this.permissionsService.getMatrix();
  }

  @Post('reload')
  @HttpCode(200)
  async reload(@Req() req: Request) {
    const user = (req as any).user;
    if (!user || user.role !== 'superadmin') throw new ForbiddenException();
    await this.permissionsService.load();
    return { ok: true };
  }
}
