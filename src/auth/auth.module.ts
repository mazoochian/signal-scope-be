import { Module } from '@nestjs/common';
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
  // Re-exports JwtConfigModule (not JwtModule directly) — Nest only allows a
  // module to export something that is part of its own `imports`, and
  // JwtModule itself isn't anymore (JwtConfigModule wraps it). Consumers of
  // AuthModule (e.g. AppModule, for JwtAuthGuard) still get JwtService
  // transitively, since JwtConfigModule itself exports JwtModule.
  exports: [AuthService, JwtConfigModule],
})
export class AuthModule {}
