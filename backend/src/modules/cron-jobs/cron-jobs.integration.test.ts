import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { buildTestApp, generateToken } from '../../test-helpers/app.js';
import { seedRegion, seedPlan, seedClient } from '../../test-helpers/fixtures.js';
import { cronJobs } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('Cron Jobs CRUD (integration)', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let clientId: string;

  beforeAll(async () => {
    await runMigrations();
    app = await buildTestApp();
    adminToken = generateToken(app, { role: 'admin' });
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    await cleanTables();
    const db = getTestDb();
    const region = await seedRegion(db);
    const plan = await seedPlan(db);
    const client = await seedClient(db, region.id, plan.id);
    clientId = client.id;
  });

  it('POST — creates cron job with 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/clients/${clientId}/cron-jobs`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Daily cleanup',
        schedule: '0 3 * * *',
        command: '/usr/bin/php /var/www/cron.php',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.name).toBe('Daily cleanup');
    expect(body.data.schedule).toBe('0 3 * * *');
    expect(body.data.enabled).toBe(1);
  });

  it('GET list — returns paginated cron jobs', async () => {
    const db = getTestDb();
    await db.insert(cronJobs).values({
      id: crypto.randomUUID(),
      clientId,
      name: 'Job 1',
      schedule: '* * * * *',
      command: 'echo hello',
    });
    await db.insert(cronJobs).values({
      id: crypto.randomUUID(),
      clientId,
      name: 'Job 2',
      schedule: '0 * * * *',
      command: 'echo world',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/clients/${clientId}/cron-jobs`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.length).toBe(2);
  });

  it('PATCH — updates cron job', async () => {
    const db = getTestDb();
    const id = crypto.randomUUID();
    await db.insert(cronJobs).values({
      id,
      clientId,
      name: 'Old name',
      schedule: '* * * * *',
      command: 'echo old',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/clients/${clientId}/cron-jobs/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'New name', enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.name).toBe('New name');
    expect(res.json().data.enabled).toBe(0);
  });

  it('DELETE — removes cron job', async () => {
    const db = getTestDb();
    const id = crypto.randomUUID();
    await db.insert(cronJobs).values({
      id,
      clientId,
      name: 'To delete',
      schedule: '* * * * *',
      command: 'echo bye',
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/clients/${clientId}/cron-jobs/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);

    // Verify deleted
    const rows = await db.select().from(cronJobs).where(eq(cronJobs.id, id));
    expect(rows.length).toBe(0);
  });

  it('returns 404 for nonexistent cron job', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/clients/${clientId}/cron-jobs/nonexistent`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('CRON_JOB_NOT_FOUND');
  });

  it('rejects invalid cron schedule', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/clients/${clientId}/cron-jobs`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Bad schedule',
        schedule: 'not-valid',
        command: 'echo fail',
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
