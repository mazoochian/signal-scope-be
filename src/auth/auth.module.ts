import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UsersModule } from '../users/users.module';
import { OidcModule } from '../oidc/oidc.module';
import { JwtConfigModule } from './jwt-config.module';

@Module({
  imports: [
    JwtConfigModule,
    UsersModule,
    OidcModule,
  ],
  providers: [AuthService],
  controllers: [AuthController],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
