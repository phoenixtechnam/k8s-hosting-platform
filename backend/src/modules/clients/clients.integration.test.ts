import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb } from '../../test-helpers/db.js';
import { buildTestApp, generateToken } from '../../test-helpers/app.js';
import { seedRegion, seedPlan, seedClient } from '../../test-helpers/fixtures.js';
import { getTestDb } from '../../test-helpers/db.js';
import type { FastifyInstance } from 'fastify';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('Client CRUD (integration)', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let supportToken: string;
  let regionId: string;
  let planId: string;

  beforeAll(async () => {
    await runMigrations();
    app = await buildTestApp();
    adminToken = generateToken(app, { role: 'admin' });
    supportToken = generateToken(app, { role: 'support' });
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
    regionId = region.id;
    planId = plan.id;
  });

  it('POST /api/v1/clients — creates client with 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        company_name: 'Integration Corp',
        company_email: 'admin@integration.com',
        plan_id: planId,
        region_id: regionId,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.companyName).toBe('Integration Corp');
    expect(body.data.status).toBe('pending');
    expect(body.data.kubernetesNamespace).toMatch(/^client-integration-corp/);
  });

  it('GET /api/v1/clients — returns paginated list', async () => {
    const db = getTestDb();
    await seedClient(db, regionId, planId, { companyName: 'Alpha' });
    await seedClient(db, regionId, planId, { companyName: 'Beta' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients?limit=10',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.length).toBe(2);
    expect(body.pagination.total_count).toBe(2);
  });

  it('GET /api/v1/clients — supports search', async () => {
    const db = getTestDb();
    await seedClient(db, regionId, planId, { companyName: 'Searchable Corp' });
    await seedClient(db, regionId, planId, { companyName: 'Hidden LLC' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients?search=Searchable',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.length).toBe(1);
    expect(res.json().data[0].companyName).toBe('Searchable Corp');
  });

  it('GET /api/v1/clients/:id — returns single client', async () => {
    const db = getTestDb();
    const client = await seedClient(db, regionId, planId);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/clients/${client.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.id).toBe(client.id);
  });

  it('GET /api/v1/clients/:id — 404 for missing client', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/nonexistent-id',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('CLIENT_NOT_FOUND');
  });

  it('PATCH /api/v1/clients/:id — updates fields', async () => {
    const db = getTestDb();
    const client = await seedClient(db, regionId, planId);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/clients/${client.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { company_name: 'Updated Name', status: 'active' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.companyName).toBe('Updated Name');
    expect(res.json().data.status).toBe('active');
  });

  it('DELETE /api/v1/clients/:id — requires cancelled status', async () => {
    const db = getTestDb();
    const client = await seedClient(db, regionId, planId, { status: 'active' });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/clients/${client.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('DELETE /api/v1/clients/:id — succeeds when cancelled', async () => {
    const db = getTestDb();
    const client = await seedClient(db, regionId, planId, { status: 'cancelled' });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/clients/${client.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);
  });

  it('returns 401 without token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/clients' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 with wrong role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients',
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
