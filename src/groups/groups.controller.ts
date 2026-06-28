import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put,
} from '@nestjs/common';
import { GroupsService, CreateGroupDto, UpdateGroupDto } from './groups.service';
import { Permission } from '../auth/guards/permission.decorator';

@Controller('groups')
export class GroupsController {
  constructor(private readonly groupsService: GroupsService) {}

  @Get()
  @Permission('groups', 'read')
  list() { return this.groupsService.list(); }

  @Post()
  @Permission('groups', 'write')
  create(@Body() dto: CreateGroupDto) { return this.groupsService.create(dto); }

  @Put(':id')
  @Permission('groups', 'write')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateGroupDto) {
    return this.groupsService.update(id, dto);
  }

  @Delete(':id')
  @Permission('groups', 'delete')
  remove(@Param('id', ParseIntPipe) id: number) { return this.groupsService.remove(id); }

  @Get(':id/members')
  @Permission('groups', 'read')
  listMembers(@Param('id', ParseIntPipe) id: number) { return this.groupsService.listMembers(id); }

  @Post(':id/members')
  @Permission('groups', 'write')
  addMember(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { userId: number },
  ) { return this.groupsService.addMember(id, body.userId); }

  @Delete(':id/members/:userId')
  @Permission('groups', 'delete')
  removeMember(
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) userId: number,
  ) { return this.groupsService.removeMember(id, userId); }
}
