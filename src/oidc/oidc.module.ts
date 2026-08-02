import { Module } from '@nestjs/common';
import { OidcService } from './oidc.service';
import { OidcController } from './oidc.controller';
import { UsersModule } from '../users/users.module';
import { JwtConfigModule } from '../auth/jwt-config.module';

@Module({
  imports: [JwtConfigModule, UsersModule],
  providers: [OidcService],
  controllers: [OidcController],
  exports: [OidcService],
})
export class OidcModule {}
