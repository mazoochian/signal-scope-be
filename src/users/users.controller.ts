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
import { AddGrantDto } from './dto/user.dto';
import { AuditLogService } from '../audit-log/audit-log.service';

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly permissionsService: PermissionsService,
    private readonly auditLog: AuditLogService,
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

  // Mirrors the superadmin protections on update()/remove(): without this,
  // any role holding users:write (e.g. admin) could mint a brand-new
  // superadmin account and log in as it, defeating those protections
  // entirely (AUDIT-REPORT.md H2).
  @Post()
  @Permission('users', 'write')
  async create(@Body() dto: CreateUserDto, @Req() req: Request) {
    const me = (req as any).user;
    if (dto.role === 'superadmin' && me.role !== 'superadmin') {
      throw new ForbiddenException('Only a superadmin can create a superadmin account');
    }
    const created = await this.usersService.create(dto);
    await this.auditLog.record({
      actorUserId: me.id, actorEmail: me.email, action: 'user.created',
      targetType: 'user', targetId: created.id, details: { email: created.email, role: created.role },
    });
    return created;
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

    // Same escalation this closes on create(): promoting an existing account
    // to superadmin is equivalent to minting one.
    if (dto.role === 'superadmin' && me.role !== 'superadmin') {
      throw new ForbiddenException('Only a superadmin can grant the superadmin role');
    }

    const updated = await this.usersService.update(id, dto);
    // AUDIT-REPORT.md M6 specifically calls out role changes — logged
    // distinctly from a plain profile edit, and only when the role
    // actually changed (self-edits of name/avatar never touch role).
    if (dto.role && dto.role !== target.role) {
      await this.auditLog.record({
        actorUserId: me.id, actorEmail: me.email, action: 'user.role_changed',
        targetType: 'user', targetId: id,
        details: { email: target.email, fromRole: target.role, toRole: dto.role },
      });
    }
    return updated;
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

    const result = await this.usersService.remove(id);
    await this.auditLog.record({
      actorUserId: me.id, actorEmail: me.email, action: 'user.deleted',
      targetType: 'user', targetId: id, details: { email: target.email, role: target.role },
    });
    return result;
  }

  @Get(':id/grants')
  @Permission('users', 'read')
  getGrants(@Param('id', ParseIntPipe) id: number) {
    return this.usersService.getGrants(id);
  }

  @Post(':id/grants')
  @Permission('users', 'write')
  async addGrant(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddGrantDto,
    @Req() req: Request,
  ) {
    const me = (req as any).user;
    const grant = await this.usersService.addGrant(id, dto);
    await this.auditLog.record({
      actorUserId: me.id, actorEmail: me.email, action: 'access_grant.created',
      targetType: 'user', targetId: id, details: { ...dto },
    });
    return grant;
  }

  @Delete(':id/grants/:grantId')
  @Permission('users', 'delete')
  async removeGrant(
    @Param('id', ParseIntPipe) id: number,
    @Param('grantId', ParseIntPipe) grantId: number,
    @Req() req: Request,
  ) {
    const me = (req as any).user;
    const result = await this.usersService.removeGrant(grantId);
    await this.auditLog.record({
      actorUserId: me.id, actorEmail: me.email, action: 'access_grant.deleted',
      targetType: 'user', targetId: id, details: { grantId },
    });
    return result;
  }
}
