import { Module } from '@nestjs/common';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';
import { DbModule } from '../db/db.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [DbModule, UsersModule],
  controllers: [GroupsController],
  providers: [GroupsService],
})
export class GroupsModule {}
