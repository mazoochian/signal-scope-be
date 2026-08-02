import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      'JWT_SECRET environment variable is not set. Refusing to start: signing ' +
        'or verifying tokens with a hardcoded default secret is a complete ' +
        'authentication bypass (see AUDIT-REPORT.md, finding C1). Set JWT_SECRET ' +
        'to a long random value (e.g. `openssl rand -hex 32`) in the environment ' +
        'before starting the server.',
    );
  }
  return secret;
}

/**
 * Single source of truth for JWT signing configuration.
 *
 * AuthModule, UsersModule, and OidcModule each used to call
 * `JwtModule.register({ secret: process.env.JWT_SECRET ?? 'dev-secret-change-me', ... })`
 * independently. That meant three separate hardcoded fallbacks that could
 * drift out of sync, and — because JWT_SECRET was never actually set in any
 * production surface — every deployment signed and verified tokens with the
 * public literal `dev-secret-change-me`, a complete auth bypass.
 *
 * Now there is exactly one JwtModule registration, with no fallback: boot
 * fails loudly if JWT_SECRET is unset. AuthModule, UsersModule, and
 * OidcModule all import this module instead of registering their own.
 */
@Module({
  imports: [
    JwtModule.register({
      secret: requireJwtSecret(),
      signOptions: { expiresIn: '7d' },
    }),
  ],
  exports: [JwtModule],
})
export class JwtConfigModule {}
