import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockConfig = {
  id: 'bc-1',
  name: 'Daily SSH Backup',
  storageType: 'ssh',
  sshHost: 'backup.example.com',
  sshPort: 22,
  sshUser: 'backup',
  sshPath: '/backups',
  s3Endpoint: null,
  s3Bucket: null,
  s3Region: null,
  s3Prefix: null,
  retentionDays: 30,
  scheduleExpression: '0 2 * * *',
  enabled: 1,
  lastTestedAt: null,
  lastTestStatus: null,
  createdAt: new Date('2026-01-01').toISOString(),
  updatedAt: new Date('2026-01-01').toISOString(),
};

vi.mock('./service.js', () => ({
  listBackupConfigs: vi.fn().mockResolvedValue([mockConfig]),
  createBackupConfig: vi.fn().mockResolvedValue(mockConfig),
  updateBackupConfig: vi.fn().mockResolvedValue({ ...mockConfig, name: 'Updated' }),
  deleteBackupConfig: vi.fn().mockResolvedValue(undefined),
  testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 42 }),
  testDraft: vi.fn().mockResolvedValue({ ok: true, latencyMs: 38 }),
  activateBackupConfig: vi.fn().mockResolvedValue({ ...mockConfig, active: true }),
  deactivateBackupConfig: vi.fn().mockResolvedValue({ ...mockConfig, active: false }),
  getActiveBackupConfig: vi.fn().mockResolvedValue({
    id: 'bc-1',
    endpoint: 'https://fsn1.example.com',
    region: 'eu-central',
    bucket: 'k8s-staging',
    accessKeyId: 'AKIA' + 'X'.repeat(16),
    secretAccessKey: 'S'.repeat(40),
    pathPrefix: undefined,
  }),
}));
vi.mock('./longhorn-reconciler.js', () => ({
  reconcileBackupTarget: vi.fn().mockResolvedValue(undefined),
  clearBackupTarget: vi.fn().mockResolvedValue(undefined),
}));

const { backupConfigRoutes } = await import('./routes.js');

describe('backup-config routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let supportToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', {});
    app.decorate('config', { OIDC_ENCRYPTION_KEY: '0'.repeat(64) });
    await app.register(backupConfigRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    supportToken = app.jwt.sign({ sub: 'support-1', role: 'support', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  // ─── Auth ────────────────────────────────────────────────────────────────

  it('GET backup-configs should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/backup-configs' });
    expect(res.statusCode).toBe(401);
  });

  it('GET backup-configs should reject non-admin role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/backup-configs',
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── GET ─────────────────────────────────────────────────────────────────

  it('GET backup-configs should return list for admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/backup-configs',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeDefined();
  });

  // ─── POST ────────────────────────────────────────────────────────────────

  it('POST backup-configs should reject missing required fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/backup-configs',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST backup-configs should create with valid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/backup-configs',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Daily SSH Backup',
        storage_type: 'ssh',
        ssh_host: 'backup.example.com',
        ssh_user: 'backup',
        ssh_key: 'ssh-ed25519 AAAA...',
        ssh_path: '/backups',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toBeDefined();
  });

  // ─── PATCH ───────────────────────────────────────────────────────────────

  it('PATCH backup-configs/:id should update', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/backup-configs/bc-1',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Updated' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeDefined();
  });

  // ─── DELETE ──────────────────────────────────────────────────────────────

  it('DELETE backup-configs/:id should return 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/backup-configs/bc-1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);
  });

  // ─── POST test ───────────────────────────────────────────────────────────

  it('POST backup-configs/:id/test should return test result', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/backup-configs/bc-1/test',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.ok).toBe(true);
    expect(res.json().data.latencyMs).toBeGreaterThan(0);
  });

  // ─── Strict validation via Zod ───────────────────────────────────────────

  const validS3Payload = {
    name: 'Primary S3',
    storage_type: 's3' as const,
    s3_endpoint: 'https://fsn1.example.com',
    s3_bucket: 'my-bucket',
    s3_region: 'eu-central',
    s3_access_key: 'A'.repeat(20),
    s3_secret_key: 'S'.repeat(40),
  };

  const postS3 = (overrides: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/admin/backup-configs',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { ...validS3Payload, ...overrides },
    });

  it('POST rejects S3 endpoint without http/https scheme', async () => {
    const res = await postS3({ s3_endpoint: 'fsn1.example.com' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/s3_endpoint|endpoint|url/i);
  });

  it('POST rejects S3 bucket with uppercase letters', async () => {
    const res = await postS3({ s3_bucket: 'My-Bucket' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/bucket/i);
  });

  it('POST rejects S3 bucket shorter than 3 chars', async () => {
    const res = await postS3({ s3_bucket: 'ab' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/bucket/i);
  });

  it('POST rejects S3 bucket longer than 63 chars', async () => {
    const res = await postS3({ s3_bucket: 'a'.repeat(64) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/bucket/i);
  });

  it('POST rejects S3 bucket with leading hyphen', async () => {
    const res = await postS3({ s3_bucket: '-leading' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/bucket/i);
  });

  it('POST rejects S3 access key shorter than 16 chars', async () => {
    const res = await postS3({ s3_access_key: 'short' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/access_key|access key/i);
  });

  it('POST accepts a fully valid S3 payload', async () => {
    const res = await postS3({});
    expect(res.statusCode).toBe(201);
  });

  // ─── POST test-draft (test-before-save) ─────────────────────────────────

  it('POST backup-configs/test-draft runs a real connectivity test on unsaved input', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/backup-configs/test-draft',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: validS3Payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.ok).toBe(true);
    expect(res.json().data.latencyMs).toBeGreaterThan(0);
  });

  it('POST backup-configs/test-draft still runs Zod validation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/backup-configs/test-draft',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { ...validS3Payload, s3_bucket: 'UPPERCASE' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST backup-configs/test-draft requires admin role', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/backup-configs/test-draft',
      headers: { authorization: `Bearer ${supportToken}` },
      payload: validS3Payload,
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── Activate / deactivate ──────────────────────────────────────────────

  it('POST backup-configs/:id/activate returns the updated row with active=true', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/backup-configs/bc-1/activate',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.active).toBe(true);
  });

  it('POST backup-configs/:id/activate requires admin role', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/backup-configs/bc-1/activate',
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST backup-configs/:id/deactivate returns the updated row with active=false', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/backup-configs/bc-1/deactivate',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.active).toBe(false);
  });
});
