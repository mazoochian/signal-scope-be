import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Response } from 'express';
import { UsersService } from '../users/users.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly usersService: UsersService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.usersService.findByEmail(email);
    if (!user || !user.passwordHash) {
      this.logger.warn(`Failed login attempt for ${email} (no such user or no password set)`);
      throw new UnauthorizedException('Invalid credentials');
    }
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      this.logger.warn(`Failed login attempt for ${email} (bad password)`);
      throw new UnauthorizedException('Invalid credentials');
    }
    if (!user.isActive) {
      this.logger.warn(`Failed login attempt for ${email} (account disabled)`);
      throw new UnauthorizedException('Account disabled');
    }
    const token = this.signToken(user);
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
