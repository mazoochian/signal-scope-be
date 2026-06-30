import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { UsersService, CreateUserDto, UpdateUserDto } from './users.service';
import { Permission } from '../auth/guards/permission.decorator';
import { PermissionsService } from '../permissions/permissions.service';

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly permissionsService: PermissionsService,
  ) {}

  @Get()
  @Permission('users', 'read')
  list() {
    return this.usersService.list();
  }

  // Self-access bypass: authenticated users can always read their own profile.
  // Others need the 'users:read' permission.
  @Get(':id')
  async getOne(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const me = (req as any).user;
    if (me.id !== id && !this.permissionsService.can(me.role, 'users', 'read')) {
      throw new ForbiddenException();
    }
    const user = await this.usersService.findById(id);
    if (!user) throw new NotFoundException();
    return this.usersService.toDto(user);
  }

  @Post()
  @Permission('users', 'write')
  create(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto);
  }

  // Self-edit bypass: authenticated users can always update their own profile,
  // but cannot change their own role. Others need 'users:write'. Superadmin
  // accounts can only be modified by superadmins.
  @Put(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
    @Req() req: Request,
  ) {
    const me = (req as any).user;
    const isSelf = me.id === id;
    const canWrite = this.permissionsService.can(me.role, 'users', 'write');

    if (!isSelf && !canWrite) throw new ForbiddenException();
    if (!canWrite && dto.role) throw new ForbiddenException('Cannot change own role');

    const target = await this.usersService.findById(id);
    if (!target) throw new NotFoundException();

    if (target.role === 'superadmin' && me.role !== 'superadmin') {
      throw new ForbiddenException('Superadmin accounts can only be modified by superadmins');
    }

    return this.usersService.update(id, dto);
  }

  @Delete(':id')
  @Permission('users', 'delete')
  async remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const me = (req as any).user;
    if (me.id === id) throw new ForbiddenException('Cannot delete yourself');

    const target = await this.usersService.findById(id);
    if (!target) throw new NotFoundException();

    if (target.role === 'superadmin' && me.role !== 'superadmin') {
      throw new ForbiddenException('Superadmin accounts can only be deleted by superadmins');
    }

    return this.usersService.remove(id);
  }

  @Get(':id/grants')
  @Permission('users', 'read')
  getGrants(@Param('id', ParseIntPipe) id: number) {
    return this.usersService.getGrants(id);
  }

  @Post(':id/grants')
  @Permission('users', 'write')
  addGrant(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { resourceType: string; resourceId?: string; permission: string },
  ) {
    return this.usersService.addGrant(id, dto);
  }

  @Delete(':id/grants/:grantId')
  @Permission('users', 'delete')
  removeGrant(@Param('grantId', ParseIntPipe) grantId: number) {
    return this.usersService.removeGrant(grantId);
  }
}
