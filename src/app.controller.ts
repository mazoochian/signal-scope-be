import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from './auth/guards/public.decorator';
import { DbService } from './db/db.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly db: DbService,
  ) {}

  @Get()
  @Public()
  getHello(): string {
    return this.appService.getHello();
  }

  // Public health check for Docker/orchestrator use (see AUDIT-REPORT.md C3 —
  // the previous healthcheck targeted GET /api/overview, which requires a
  // valid JWT, so the compose stack could never report healthy). Does a real
  // DB round-trip so "healthy" means the API can actually serve requests, not
  // just that the process is up.
  @Get('health')
  @Public()
  async health() {
    try {
      await this.db.query('SELECT 1');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ServiceUnavailableException(`Database is not reachable: ${message}`);
    }
    return { status: 'ok', db: 'up' };
  }
}
