import { Module } from '@nestjs/common';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';
import { DbModule } from '../db/db.module';

@Module({
  imports: [DbModule],
  controllers: [GroupsController],
  providers: [GroupsService],
})
export class GroupsModule {}
