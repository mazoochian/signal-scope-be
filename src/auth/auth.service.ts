import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Response } from 'express';
import { UsersService } from '../users/users.service';
import { AuditLogService } from '../audit-log/audit-log.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly usersService: UsersService,
    private readonly auditLog: AuditLogService,
  ) {}

  // AUDIT-REPORT.md M6: login events (success and failure) were only ever
  // logged to stdout via `this.logger.warn`, never persisted — no way to
  // answer "who logged in" or "was this account targeted by a brute-force
  // attempt" after the fact. ipAddress is optional so this stays callable
  // from anywhere that doesn't have a request object (tests, scripts).
  async login(email: string, password: string, ipAddress?: string | null) {
    const user = await this.usersService.findByEmail(email);
    if (!user || !user.passwordHash) {
      this.logger.warn(`Failed login attempt for ${email} (no such user or no password set)`);
      await this.auditLog.record({
        actorUserId: null, actorEmail: email, action: 'login.failure',
        details: { reason: 'no_such_user_or_no_password' }, ipAddress,
      });
      throw new UnauthorizedException('Invalid credentials');
    }
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      this.logger.warn(`Failed login attempt for ${email} (bad password)`);
      await this.auditLog.record({
        actorUserId: user.id, actorEmail: email, action: 'login.failure',
        details: { reason: 'bad_password' }, ipAddress,
      });
      throw new UnauthorizedException('Invalid credentials');
    }
    if (!user.isActive) {
      this.logger.warn(`Failed login attempt for ${email} (account disabled)`);
      await this.auditLog.record({
        actorUserId: user.id, actorEmail: email, action: 'login.failure',
        details: { reason: 'account_disabled' }, ipAddress,
      });
      throw new UnauthorizedException('Account disabled');
    }
    const token = this.signToken(user);
    await this.auditLog.record({
      actorUserId: user.id, actorEmail: email, action: 'login.success', ipAddress,
    });
    return { token, user: this.usersService.toDto(user) };
  }

  signToken(user: { id: number; email: string; role: string }): string {
    return this.jwtService.sign({ sub: user.id, email: user.email, role: user.role });
  }

  verifyToken(token: string): { sub: number; email: string; role: string } {
    return this.jwtService.verify(token);
  }

  setTokenCookie(res: Response, token: string) {
    res.cookie('ss-token', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      secure: process.env.NODE_ENV === 'production',
    });
  }

  clearTokenCookie(res: Response) {
    res.clearCookie('ss-token');
  }
}
