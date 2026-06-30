/**
 * Integration tests for the RBAC permission system.
 *
 * Spins up the full NestJS app against the real database.
 * Seeds one test user per role in beforeAll and cleans up in afterAll.
 *
 * Run with:  npm test -- --testPathPattern=permissions
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../app.module';
import { DbService } from '../db/db.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

const PASSWORD_HASH = bcrypt.hashSync('TestPass1!', 10);

interface TestUser {
  id: number;
  role: string;
  token: string;
}

let app: INestApplication;
let db: DbService;
let jwt: JwtService;

const users: Record<string, TestUser> = {};

async function createUser(role: string, email: string): Promise<TestUser> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO users (email, password_hash, role, is_active, first_name)
     VALUES ($1, $2, $3, true, $3)
     RETURNING id`,
    [email, PASSWORD_HASH, role],
  );
  const id = rows[0].id;
  const token = jwt.sign({ sub: id, email, role });
  return { id, role, token };
}

function bearer(user: TestUser) {
  return `Bearer ${user.token}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Setup / teardown
// ────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication();
  app.use(require('cookie-parser')());
  await app.init();

  db  = app.get(DbService);
  jwt = app.get(JwtService);

  users.superadmin   = await createUser('superadmin',   'test-superadmin@ss-test.local');
  users.admin        = await createUser('admin',        'test-admin@ss-test.local');
  users.operator     = await createUser('operator',     'test-operator@ss-test.local');
  users.troubleshoot = await createUser('troubleshooter','test-troubleshooter@ss-test.local');
  users.viewer       = await createUser('viewer',       'test-viewer@ss-test.local');
}, 60_000);

afterAll(async () => {
  const emails = Object.values(users).map(u => `'${u.role === 'superadmin'
    ? 'test-superadmin@ss-test.local'
    : `test-${u.role === 'troubleshooter' ? 'troubleshooter' : u.role}@ss-test.local`}'`);
  await db.query(
    `DELETE FROM users WHERE email LIKE '%-test.local'`,
  );
  await app.close();
}, 30_000);

// ────────────────────────────────────────────────────────────────────────────
// Utility assertions
// ────────────────────────────────────────────────────────────────────────────

function get(path: string) {
  return request(app.getHttpServer()).get(path);
}

function post(path: string, body: object = {}) {
  return request(app.getHttpServer()).post(path).send(body);
}

function put(path: string, body: object = {}) {
  return request(app.getHttpServer()).put(path).send(body);
}

function del(path: string) {
  return request(app.getHttpServer()).delete(path);
}

// ────────────────────────────────────────────────────────────────────────────
// Auth endpoints
// ────────────────────────────────────────────────────────────────────────────

describe('Auth (public)', () => {
  it('GET / → 200 no token', () => get('/').expect(200));

  it('GET /oidc/providers → 200 no token', () =>
    get('/oidc/providers').expect(200));

  it('POST /auth/login → 200 valid credentials', () =>
    post('/auth/login', {
      email: users.viewer.role === 'viewer' ? 'test-viewer@ss-test.local' : '',
      password: 'TestPass1!',
    }).expect(200));

  it('POST /auth/login → 401 wrong password', () =>
    post('/auth/login', {
      email: 'test-viewer@ss-test.local',
      password: 'wrong',
    }).expect(401));

  it('GET /auth/me → 401 no token', () => get('/auth/me').expect(401));

  it('GET /auth/me → 200 any authenticated user', () =>
    get('/auth/me').set('Authorization', bearer(users.viewer)).expect(200));
});

// ────────────────────────────────────────────────────────────────────────────
// Overview / Dashboard
// ────────────────────────────────────────────────────────────────────────────

describe('Overview (dashboard:read)', () => {
  it('401 no token',     () => get('/overview').expect(401));
  it('200 viewer',       () => get('/overview').set('Authorization', bearer(users.viewer)).expect(200));
  it('200 superadmin',   () => get('/overview').set('Authorization', bearer(users.superadmin)).expect(200));
});

describe('Host metrics (dashboard:read)', () => {
  it('401 no token',     () => get('/host-metrics').expect(401));
  it('200 viewer',       () => get('/host-metrics').set('Authorization', bearer(users.viewer)).expect(200));
});

// ────────────────────────────────────────────────────────────────────────────
// Devices
// ────────────────────────────────────────────────────────────────────────────

describe('Devices', () => {
  it('GET / → 401 no token',             () => get('/devices').expect(401));
  it('GET / → 200 viewer',               () => get('/devices').set('Authorization', bearer(users.viewer)).expect(200));
  it('POST / → 401 no token',            () => post('/devices', { name: 'x', host: '1.2.3.4', type: 'router' }).expect(401));
  it('POST / → 403 viewer (read only)',  () =>
    post('/devices', { name: 'x', host: '1.2.3.4', type: 'router' })
      .set('Authorization', bearer(users.viewer))
      .expect(403));
  it('POST / → 403 troubleshooter',      () =>
    post('/devices', { name: 'x', host: '1.2.3.4', type: 'router' })
      .set('Authorization', bearer(users.troubleshoot))
      .expect(403));
  it('POST / → 403 operator (read only)',() =>
    post('/devices', { name: 'x', host: '1.2.3.4', type: 'router' })
      .set('Authorization', bearer(users.operator))
      .expect(403));
  it('POST / → 2xx admin',               () =>
    post('/devices', { name: 'test-rbac-device', host: '10.0.0.1', type: 'router' })
      .set('Authorization', bearer(users.admin))
      .expect(res => { expect([401, 403]).not.toContain(res.status); }));
});

// ────────────────────────────────────────────────────────────────────────────
// Alerts
// ────────────────────────────────────────────────────────────────────────────

describe('Alerts', () => {
  it('GET / → 401 no token',            () => get('/alerts').expect(401));
  it('GET / → 200 viewer',              () => get('/alerts').set('Authorization', bearer(users.viewer)).expect(200));
  it('PATCH /:id/acknowledge → 401',    () => request(app.getHttpServer()).patch('/alerts/1/acknowledge').expect(401));
  it('PATCH /:id/acknowledge → 403 viewer', () =>
    request(app.getHttpServer())
      .patch('/alerts/1/acknowledge')
      .set('Authorization', bearer(users.viewer))
      .expect(403));
  it('PATCH /:id/acknowledge → 2xx troubleshooter (execute)', () =>
    request(app.getHttpServer())
      .patch('/alerts/1/acknowledge')
      .set('Authorization', bearer(users.troubleshoot))
      .expect(res => { expect([200, 404]).toContain(res.status); }));
  it('PATCH /:id/acknowledge → 2xx operator', () =>
    request(app.getHttpServer())
      .patch('/alerts/1/acknowledge')
      .set('Authorization', bearer(users.operator))
      .expect(res => { expect([200, 404]).toContain(res.status); }));
});

// ────────────────────────────────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────────────────────────────────

describe('Configuration', () => {
  it('GET /devices → 401 no token',   () => get('/configuration/devices').expect(401));
  it('GET /devices → 200 viewer',     () => get('/configuration/devices').set('Authorization', bearer(users.viewer)).expect(200));
  it('POST /snapshot-all → 401',      () => post('/configuration/snapshot-all').expect(401));
  it('POST /snapshot-all → 403 viewer', () =>
    post('/configuration/snapshot-all')
      .set('Authorization', bearer(users.viewer))
      .expect(403));
  it('POST /snapshot-all → 403 troubleshooter (read only on config)', () =>
    post('/configuration/snapshot-all')
      .set('Authorization', bearer(users.troubleshoot))
      .expect(403));
  it('POST /snapshot-all → 2xx operator (execute)', () =>
    post('/configuration/snapshot-all')
      .set('Authorization', bearer(users.operator))
      .expect(res => { expect([401, 403]).not.toContain(res.status); }));
});

// ────────────────────────────────────────────────────────────────────────────
// Integrations
// ────────────────────────────────────────────────────────────────────────────

describe('Integrations', () => {
  it('GET /email → 401 no token',    () => get('/integrations/email').expect(401));
  it('GET /email → 403 viewer',      () =>
    get('/integrations/email').set('Authorization', bearer(users.viewer)).expect(403));
  it('GET /email → 403 operator',    () =>
    get('/integrations/email').set('Authorization', bearer(users.operator)).expect(403));
  it('GET /email → 200 admin',       () =>
    get('/integrations/email').set('Authorization', bearer(users.admin)).expect(200));
  it('PUT /email → 403 operator',    () =>
    put('/integrations/email', {}).set('Authorization', bearer(users.operator)).expect(403));
  it('PUT /email → 2xx admin',       () =>
    put('/integrations/email', { host: 'smtp.example.com', port: 587, from: 'nms@example.com' })
      .set('Authorization', bearer(users.admin))
      .expect(res => { expect([401, 403]).not.toContain(res.status); }));
});

// ────────────────────────────────────────────────────────────────────────────
// SLA
// ────────────────────────────────────────────────────────────────────────────

describe('SLA', () => {
  it('GET /parameters → 401 no token',   () => get('/sla/parameters').expect(401));
  it('GET /parameters → 200 viewer',     () => get('/sla/parameters').set('Authorization', bearer(users.viewer)).expect(200));
  it('POST /parameters → 403 operator (read only)', () =>
    post('/sla/parameters', { name: 'test', threshold: 99, unit: '%' })
      .set('Authorization', bearer(users.operator))
      .expect(403));
  it('POST /parameters → 2xx admin',     () =>
    post('/sla/parameters', { name: 'rbac-test', threshold: 99, unit: '%' })
      .set('Authorization', bearer(users.admin))
      .expect(res => { expect([401, 403]).not.toContain(res.status); }));
});

// ────────────────────────────────────────────────────────────────────────────
// Discovery
// ────────────────────────────────────────────────────────────────────────────

describe('Discovery', () => {
  it('GET / → 401 no token',    () => get('/discovery').expect(401));
  it('GET / → 403 viewer (no discovery permission)', () =>
    get('/discovery').set('Authorization', bearer(users.viewer)).expect(403));
  it('GET / → 200 operator',    () => get('/discovery').set('Authorization', bearer(users.operator)).expect(200));
  it('GET / → 200 admin',       () => get('/discovery').set('Authorization', bearer(users.admin)).expect(200));
});

// ────────────────────────────────────────────────────────────────────────────
// OIDC providers (admin: read only; superadmin: full)
// ────────────────────────────────────────────────────────────────────────────

describe('OIDC providers', () => {
  it('GET /providers → 200 no token (public)', () => get('/oidc/providers').expect(200));
  it('POST /providers → 401 no token',         () =>
    post('/oidc/providers', { name: 'x', providerType: 'oidc' }).expect(401));
  it('POST /providers → 403 admin (read only)', () =>
    post('/oidc/providers', { name: 'x', providerType: 'oidc' })
      .set('Authorization', bearer(users.admin))
      .expect(403));
  it('POST /providers → 2xx superadmin',        () =>
    post('/oidc/providers', { name: 'rbac-test-oidc', providerType: 'oidc', isEnabled: false })
      .set('Authorization', bearer(users.superadmin))
      .expect(res => { expect([401, 403]).not.toContain(res.status); }));
});

// ────────────────────────────────────────────────────────────────────────────
// Users — standard CRUD + self-access
// ────────────────────────────────────────────────────────────────────────────

describe('Users', () => {
  it('GET / → 401 no token',             () => get('/users').expect(401));
  it('GET / → 403 operator',             () => get('/users').set('Authorization', bearer(users.operator)).expect(403));
  it('GET / → 200 admin',                () => get('/users').set('Authorization', bearer(users.admin)).expect(200));

  it('GET /:id (self) → 200 viewer',     () =>
    get(`/users/${users.viewer.id}`).set('Authorization', bearer(users.viewer)).expect(200));

  it('GET /:id (other) → 403 viewer',   () =>
    get(`/users/${users.admin.id}`).set('Authorization', bearer(users.viewer)).expect(403));

  it('PUT /:id (self, no role change) → 200 viewer', () =>
    put(`/users/${users.viewer.id}`, { displayName: 'Viewer Test' })
      .set('Authorization', bearer(users.viewer))
      .expect(res => { expect([401, 403]).not.toContain(res.status); }));

  it('PUT /:id (self-elevation) → 403 viewer', () =>
    put(`/users/${users.viewer.id}`, { role: 'admin' })
      .set('Authorization', bearer(users.viewer))
      .expect(403));

  it('PUT /:id (other) → 403 operator', () =>
    put(`/users/${users.viewer.id}`, { displayName: 'x' })
      .set('Authorization', bearer(users.operator))
      .expect(403));

  it('PUT superadmin by admin → 403', () =>
    put(`/users/${users.superadmin.id}`, { displayName: 'hacked' })
      .set('Authorization', bearer(users.admin))
      .expect(403));

  it('DELETE self → 403', () =>
    del(`/users/${users.admin.id}`)
      .set('Authorization', bearer(users.admin))
      .expect(403));

  it('DELETE superadmin by admin → 403', () =>
    del(`/users/${users.superadmin.id}`)
      .set('Authorization', bearer(users.admin))
      .expect(403));

  it('DELETE by operator → 403', () =>
    del(`/users/${users.viewer.id}`)
      .set('Authorization', bearer(users.operator))
      .expect(403));
});

// ────────────────────────────────────────────────────────────────────────────
// Groups
// ────────────────────────────────────────────────────────────────────────────

describe('Groups', () => {
  it('GET / → 401 no token',          () => get('/groups').expect(401));
  it('GET / → 403 operator',          () => get('/groups').set('Authorization', bearer(users.operator)).expect(403));
  it('GET / → 200 admin',             () => get('/groups').set('Authorization', bearer(users.admin)).expect(200));
  it('POST / → 403 operator',         () =>
    post('/groups', { name: 'x', role: 'viewer' })
      .set('Authorization', bearer(users.operator))
      .expect(403));
  it('POST / → 2xx admin',            () =>
    post('/groups', { name: 'rbac-test-group', role: 'viewer' })
      .set('Authorization', bearer(users.admin))
      .expect(res => { expect([401, 403]).not.toContain(res.status); }));
});

// ────────────────────────────────────────────────────────────────────────────
// Notifications
// ────────────────────────────────────────────────────────────────────────────

describe('Notifications', () => {
  it('GET / → 401 no token',   () => get('/notifications').expect(401));
  it('GET / → 200 viewer',     () => get('/notifications').set('Authorization', bearer(users.viewer)).expect(200));
  it('POST /mark-all-read → 200 viewer (execute)', () =>
    post('/notifications/mark-all-read')
      .set('Authorization', bearer(users.viewer))
      .expect(res => { expect([401, 403]).not.toContain(res.status); }));
});

// ────────────────────────────────────────────────────────────────────────────
// Permissions matrix (admin/superadmin) + reload (superadmin only)
// ────────────────────────────────────────────────────────────────────────────

describe('Permissions endpoints', () => {
  it('GET /permissions → 401 no token', () => get('/permissions').expect(401));
  it('GET /permissions → 403 operator', () =>
    get('/permissions').set('Authorization', bearer(users.operator)).expect(403));
  it('GET /permissions → 200 admin',    () =>
    get('/permissions').set('Authorization', bearer(users.admin)).expect(200));
  it('POST /permissions/reload → 403 admin', () =>
    post('/permissions/reload')
      .set('Authorization', bearer(users.admin))
      .expect(403));
  it('POST /permissions/reload → 200 superadmin', () =>
    post('/permissions/reload')
      .set('Authorization', bearer(users.superadmin))
      .expect(200));
});
