import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { UsersService } from '../../users/users.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly usersService: UsersService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const token = this.extractToken(req);
    if (!token) throw new UnauthorizedException('No token');
    let payload: { sub: number; email: string; role: string };
    try {
      payload = this.jwtService.verify(token);
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
    const user = await this.usersService.findById(payload.sub);
    if (!user || !user.isActive) throw new UnauthorizedException('User not found');
    (req as any).user = this.usersService.toDto(user);
    return true;
  }

  private extractToken(req: Request): string | undefined {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice(7);
    return (req.cookies as Record<string, string>)?.['ss-token'];
  }
}
