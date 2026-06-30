import { Global, Module } from '@nestjs/common';
import { PermissionsService } from './permissions.service';
import { PermissionsController } from './permissions.controller';

@Global()
@Module({
  providers: [PermissionsService],
  exports: [PermissionsService],
  controllers: [PermissionsController],
})
export class PermissionsModule {}
