import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { OidcService } from './oidc.service';
import { OidcController } from './oidc.controller';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
      signOptions: { expiresIn: '7d' },
    }),
    UsersModule,
  ],
  providers: [OidcService],
  controllers: [OidcController],
  exports: [OidcService],
})
export class OidcModule {}
