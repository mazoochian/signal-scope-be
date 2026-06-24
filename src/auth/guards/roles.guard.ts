import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';

const ROLE_RANK: Record<string, number> = {
  superadmin: 100,
  admin: 80,
  operator: 60,
  troubleshooter: 40,
  viewer: 20,
};

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const user = ctx.switchToHttp().getRequest().user;
    if (!user) throw new ForbiddenException();
    const userRank = ROLE_RANK[user.role] ?? 0;
    const minRank = Math.min(...required.map((r) => ROLE_RANK[r] ?? 0));
    if (userRank < minRank) throw new ForbiddenException('Insufficient role');
    return true;
  }
}
