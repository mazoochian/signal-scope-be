import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { DbService } from '../db/db.service';

type Action = 'read' | 'write' | 'execute' | 'delete' | 'manage';

// Which granted actions satisfy a required action.
// execute and write are siblings (neither implies the other); both imply read.
// delete implies write, execute, and read. manage implies everything.
const SATISFIES: Record<Action, Action[]> = {
  manage:  ['manage', 'delete', 'write', 'execute', 'read'],
  delete:  ['delete', 'write', 'execute', 'read'],
  write:   ['write', 'read'],
  execute: ['execute', 'read'],
  read:    ['read'],
};

@Injectable()
export class PermissionsService implements OnModuleInit {
  private readonly logger = new Logger(PermissionsService.name);
  // "role:resource" → Set of granted actions
  private cache = new Map<string, Set<Action>>();

  constructor(private readonly db: DbService) {}

  async onModuleInit() {
    await this.load();
  }

  async load(): Promise<void> {
    const { rows } = await this.db.query<{ role: string; resource: string; action: Action }>(
      'SELECT role, resource, action FROM role_permissions',
    );
    const next = new Map<string, Set<Action>>();
    for (const { role, resource, action } of rows) {
      const key = `${role}:${resource}`;
      if (!next.has(key)) next.set(key, new Set());
      next.get(key)!.add(action);
    }
    this.cache = next;
    this.logger.log(`Loaded ${rows.length} permission rows`);
  }

  can(role: string, resource: string, required: Action): boolean {
    // Superadmin wildcard
    if (this.cache.get(`${role}:*`)?.has('manage')) return true;

    const granted = this.cache.get(`${role}:${resource}`);
    if (!granted || granted.size === 0) return false;

    for (const held of granted) {
      if (SATISFIES[held]?.includes(required)) return true;
    }
    return false;
  }

  // Returns the full matrix, useful for the settings UI
  getMatrix(): { role: string; resource: string; action: string }[] {
    const result: { role: string; resource: string; action: string }[] = [];
    for (const [key, actions] of this.cache) {
      const [role, resource] = key.split(':');
      for (const action of actions) {
        result.push({ role, resource, action });
      }
    }
    return result;
  }
}
