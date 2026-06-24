import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { UsersService, CreateUserDto, UpdateUserDto } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/guards/roles.decorator';

const ROLE_RANK: Record<string, number> = {
  superadmin: 100, admin: 80, operator: 60, troubleshooter: 40, viewer: 20,
};

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @Roles('admin')
  list() {
    return this.usersService.list();
  }

  @Get(':id')
  async getOne(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const me = (req as any).user;
    if (me.id !== id && ROLE_RANK[me.role] < 80) throw new ForbiddenException();
    const user = await this.usersService.findById(id);
    if (!user) throw new ForbiddenException();
    return this.usersService.toDto(user);
  }

  @Post()
  @Roles('admin')
  create(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto);
  }

  @Put(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
    @Req() req: Request,
  ) {
    const me = (req as any).user;
    const isAdmin = ROLE_RANK[me.role] >= 80;
    if (me.id !== id && !isAdmin) throw new ForbiddenException();
    // non-admins cannot change role
    if (!isAdmin && dto.role) throw new ForbiddenException('Cannot change own role');
    return this.usersService.update(id, dto);
  }

  @Delete(':id')
  @Roles('admin')
  async remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const me = (req as any).user;
    if (me.id === id) throw new ForbiddenException('Cannot delete yourself');
    return this.usersService.remove(id);
  }

  @Get(':id/grants')
  @Roles('admin')
  getGrants(@Param('id', ParseIntPipe) id: number) {
    return this.usersService.getGrants(id);
  }

  @Post(':id/grants')
  @Roles('admin')
  addGrant(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { resourceType: string; resourceId?: string; permission: string },
  ) {
    return this.usersService.addGrant(id, dto);
  }

  @Delete(':id/grants/:grantId')
  @Roles('admin')
  removeGrant(@Param('grantId', ParseIntPipe) grantId: number) {
    return this.usersService.removeGrant(grantId);
  }
}
