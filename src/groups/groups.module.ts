import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';
import { DbModule } from '../db/db.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    DbModule,
    UsersModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [GroupsController],
  providers: [GroupsService],
})
export class GroupsModule {}
