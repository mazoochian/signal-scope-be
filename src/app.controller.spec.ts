import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SimulationService } from './simulation/simulation.service';
import { EmailNotificationsService } from './integrations/email-notifications.service';
import { DbService } from './db/db.service';

// AppService grew constructor dependencies (SimulationService,
// EmailNotificationsService) that this scaffold test never picked up, so it
// failed on every run (AUDIT-REPORT.md L3). AppController also now depends on
// DbService for the health check (see AUDIT-REPORT.md C3). None of these are
// exercised by the tests below, so plain jest.fn() stubs are enough — no need
// to pull in the real dependency graph.
describe('AppController', () => {
  let appController: AppController;
  let dbQuery: jest.Mock;

  beforeEach(async () => {
    dbQuery = jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });

    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        { provide: SimulationService, useValue: { setAlertNotifier: jest.fn() } },
        { provide: EmailNotificationsService, useValue: { notifyAlert: jest.fn() } },
        { provide: DbService, useValue: { query: dbQuery } },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });

  describe('health', () => {
    it('returns ok when the DB responds', async () => {
      await expect(appController.health()).resolves.toEqual({ status: 'ok', db: 'up' });
      expect(dbQuery).toHaveBeenCalledWith('SELECT 1');
    });

    it('throws when the DB is unreachable', async () => {
      dbQuery.mockRejectedValueOnce(new Error('connection refused'));
      await expect(appController.health()).rejects.toThrow('Database is not reachable');
    });
  });
});
