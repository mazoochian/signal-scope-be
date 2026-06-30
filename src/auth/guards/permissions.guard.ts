import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';
import { PERMISSION_KEY, PermissionRequirement } from './permission.decorator';
import { PermissionsService } from '../../permissions/permissions.service';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissionsService: PermissionsService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const perm = this.reflector.getAllAndOverride<PermissionRequirement>(PERMISSION_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    // No @Permission — just JWT is required (handled by JwtAuthGuard)
    if (!perm) return true;

    const user = ctx.switchToHttp().getRequest().user;
    if (!user) throw new UnauthorizedException();

    if (!this.permissionsService.can(user.role, perm.resource, perm.action)) {
      throw new ForbiddenException(
        `Role '${user.role}' lacks '${perm.action}' on '${perm.resource}'`,
      );
    }
    return true;
  }
}
