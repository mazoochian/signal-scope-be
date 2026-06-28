import { SetMetadata } from '@nestjs/common';

export const PERMISSION_KEY = 'permission';

export interface PermissionRequirement {
  resource: string;
  action: 'read' | 'write' | 'execute' | 'delete' | 'manage';
}

export const Permission = (
  resource: string,
  action: PermissionRequirement['action'],
) => SetMetadata(PERMISSION_KEY, { resource, action });
