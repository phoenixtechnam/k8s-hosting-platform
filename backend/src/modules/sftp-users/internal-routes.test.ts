import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// Mock external dependencies that internal-routes imports
vi.mock('../file-manager/k8s-lifecycle.js', () => ({
  ensureFileManagerRunning: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../file-manager/idle-cleanup.js', () => ({
  recordFileManagerAccess: vi.fn(),
}));

vi.mock('../k8s-provisioner/k8s-client.js', () => ({
  createK8sClients: vi.fn().mockReturnValue({}),
}));

const { sftpInternalRoutes } = await import('./internal-routes.js');

const INTERNAL_SECRET = 'test-internal-secret';

// ─── Mock DB Builder ─────────────────────────────────────────────────────────

function buildMockRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sftp-1',
    clientId: 'c1',
    username: 'testuser',
    passwordHash: '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012',
    description: null,
    enabled: 1,
    homePath: '/',
    allowWrite: 1,
    allowDelete: 0,
    ipWhitelist: null,
    maxConcurrentSessions: 3,
    lastLoginAt: null,
    lastLoginIp: null,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildMockDb(selectResult: unknown[] = []) {
  const mockSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(selectResult),
      }),
    }),
    update: vi.fn().mockReturnValue({ set: mockSet }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
  };
}

describe('sftp internal routes', () => {
  let app: FastifyInstance;
  let mockDb: ReturnType<typeof buildMockDb>;

  beforeEach(async () => {
    process.env.PLATFORM_INTERNAL_SECRET = INTERNAL_SECRET;
    process.env.KUBECONFIG = '/dev/null';

    mockDb = buildMockDb();

    app = Fastify();
    app.decorate('db', mockDb);
    await app.register(sftpInternalRoutes, { prefix: '/api/v1' });
    await app.ready();
  });

  afterAll(async () => {
    delete process.env.PLATFORM_INTERNAL_SECRET;
  });

  // ─── Auth Header Enforcement ────────────────────────────────────────────

  describe('X-Internal-Auth enforcement', () => {
    it('should return 403 without X-Internal-Auth header', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/sftp/auth',
        payload: { username: 'test', password: 'test', source_ip: '10.0.0.1' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('should return 403 with wrong X-Internal-Auth header', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/sftp/auth',
        headers: { 'x-internal-auth': 'wrong-secret' },
        payload: { username: 'test', password: 'test', source_ip: '10.0.0.1' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('should accept valid X-Internal-Auth header', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/sftp/auth',
        headers: { 'x-internal-auth': INTERNAL_SECRET },
        payload: { username: 'test', password: 'test', source_ip: '10.0.0.1' },
      });
      // Should succeed (200) even if user not found — returns {data: {allowed: false}}
      expect(res.statusCode).toBe(200);
    });
  });

  // ─── Password Auth ──────────────────────────────────────────────────────

  describe('POST /internal/sftp/auth', () => {
    it('should return {data: {allowed: false}} when user not found', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/sftp/auth',
        headers: { 'x-internal-auth': INTERNAL_SECRET },
        payload: { username: 'nonexistent', password: 'test', source_ip: '10.0.0.1' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toBeDefined();
      expect(body.data.allowed).toBe(false);
    });

    it('should return {data: {allowed: false}} when user is disabled', async () => {
      const row = buildMockRow({ enabled: 0 });
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([row]),
        }),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/sftp/auth',
        headers: { 'x-internal-auth': INTERNAL_SECRET },
        payload: { username: 'testuser', password: 'test', source_ip: '10.0.0.1' },
      });

      expect(res.json().data.allowed).toBe(false);
    });

    it('should return {data: {allowed: false}} when user is expired', async () => {
      const row = buildMockRow({ expiresAt: new Date('2020-01-01') });
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([row]),
        }),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/sftp/auth',
        headers: { 'x-internal-auth': INTERNAL_SECRET },
        payload: { username: 'testuser', password: 'test', source_ip: '10.0.0.1' },
      });

      expect(res.json().data.allowed).toBe(false);
    });

    it('should return response wrapped in {data: ...} envelope', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/sftp/auth',
        headers: { 'x-internal-auth': INTERNAL_SECRET },
        payload: { username: 'test', password: 'test', source_ip: '10.0.0.1' },
      });

      const body = res.json();
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('allowed');
    });
  });

  // ─── Audit Ingestion ────────────────────────────────────────────────────

  describe('POST /internal/sftp/audit', () => {
    it('should return 400 when events array is empty', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/sftp/audit',
        headers: { 'x-internal-auth': INTERNAL_SECRET },
        payload: { events: [] },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should insert events and return wrapped count', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/sftp/audit',
        headers: { 'x-internal-auth': INTERNAL_SECRET },
        payload: {
          events: [
            {
              client_id: 'c1',
              event: 'CONNECT',
              source_ip: '10.0.0.1',
              protocol: 'sftp',
              session_id: 'sess-1',
            },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.inserted).toBe(1);
    });

    it('should return response wrapped in {data: ...} envelope', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/sftp/audit',
        headers: { 'x-internal-auth': INTERNAL_SECRET },
        payload: {
          events: [{ client_id: 'c1', event: 'CONNECT', source_ip: '10.0.0.1' }],
        },
      });

      const body = res.json();
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('inserted');
    });
  });

  // ─── Ensure File Manager ────────────────────────────────────────────────

  describe('POST /internal/sftp/ensure-file-manager', () => {
    it('should return pod_name wrapped in envelope', async () => {
      // Namespace validation requires a matching client row
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: 'c1' }]),
        }),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/sftp/ensure-file-manager',
        headers: { 'x-internal-auth': INTERNAL_SECRET },
        payload: { namespace: 'client-abc' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.pod_name).toBe('file-manager');
    });

    it('should return 403 for unknown namespace', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/sftp/ensure-file-manager',
        headers: { 'x-internal-auth': INTERNAL_SECRET },
        payload: { namespace: 'kube-system' },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ─── Update Login ──────────────────────────────────────────────────────

  describe('POST /internal/sftp/update-login', () => {
    it('should return {data: {updated: false}} when user not found', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/sftp/update-login',
        headers: { 'x-internal-auth': INTERNAL_SECRET },
        payload: { username: 'nonexistent', source_ip: '10.0.0.1' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.updated).toBe(false);
    });

    it('should return {data: {updated: true}} when user found', async () => {
      const row = buildMockRow();
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([row]),
        }),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/sftp/update-login',
        headers: { 'x-internal-auth': INTERNAL_SECRET },
        payload: { username: 'testuser', source_ip: '10.0.0.1' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.updated).toBe(true);
    });
  });
});
