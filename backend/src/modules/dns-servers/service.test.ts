import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ──────────────────────────────────────────────────────

const mockTestConnection = vi.fn().mockResolvedValue({ status: 'ok', message: 'Connection OK' });

vi.mock('./providers/index.js', () => ({
  createProvider: vi.fn().mockReturnValue({
    testConnection: (...args: unknown[]) => mockTestConnection(...args),
  }),
}));

vi.mock('../oidc/crypto.js', () => ({
  encrypt: vi.fn().mockReturnValue('encrypted-config-data'),
  decrypt: vi.fn().mockReturnValue('{"apiKey":"test-key"}'),
}));

vi.mock('../../shared/errors.js', () => ({
  ApiError: class ApiError extends Error {
    code: string;
    statusCode: number;
    constructor(code: string, message: string, statusCode: number) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
    }
  },
}));

const mockServer = {
  id: 'dns-1',
  displayName: 'Test PowerDNS',
  providerType: 'powerdns' as const,
  connectionConfigEncrypted: 'encrypted-config-data',
  zoneDefaultKind: 'Native' as const,
  isDefault: 1,
  enabled: 1,
  lastHealthCheck: new Date('2026-01-01'),
  lastHealthStatus: 'ok',
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

// ─── DB Mock ────────────────────────────────────────────────────────────────

let serverStore: Array<typeof mockServer> = [];

function createMockDb() {
  return {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        orderBy: vi.fn().mockImplementation(() => Promise.resolve(serverStore)),
        where: vi.fn().mockImplementation((condition: { _type: string; value: string }) => {
          const id = condition?.value as string;
          if (id === '1') {
            return Promise.resolve(serverStore.filter(s => s.enabled === 1));
          }
          const found = serverStore.filter(s => s.id === id);
          return Promise.resolve(found);
        }),
      })),
    })),
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
        serverStore.push({ ...mockServer, ...vals } as typeof mockServer);
        return Promise.resolve(undefined);
      }),
    })),
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    })),
    delete: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockImplementation((condition: { _type: string; value: string }) => {
        const id = condition?.value as string;
        serverStore = serverStore.filter(s => s.id !== id);
        return Promise.resolve(undefined);
      }),
    })),
  } as unknown as import('../../db/index.js').Database;
}

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, value: unknown) => ({ _type: 'eq', value })),
  asc: vi.fn((_col: unknown) => '_asc'),
}));

vi.mock('../../db/schema.js', () => ({
  dnsServers: {
    id: 'dnsServers.id',
    displayName: 'dnsServers.displayName',
    providerType: 'dnsServers.providerType',
    connectionConfigEncrypted: 'dnsServers.connectionConfigEncrypted',
    zoneDefaultKind: 'dnsServers.zoneDefaultKind',
    isDefault: 'dnsServers.isDefault',
    enabled: 'dnsServers.enabled',
    lastHealthCheck: 'dnsServers.lastHealthCheck',
    lastHealthStatus: 'dnsServers.lastHealthStatus',
    createdAt: 'dnsServers.createdAt',
    updatedAt: 'dnsServers.updatedAt',
  },
}));

// ─── Import module under test ───────────────────────────────────────────────

const {
  listDnsServers,
  getDnsServerById,
  createDnsServer,
  deleteDnsServer,
  testDnsServerConnection,
  getProviderForServer,
  getActiveServers,
} = await import('./service.js');

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('dns-servers service', () => {
  beforeEach(() => {
    serverStore = [{ ...mockServer }];
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ status: 'ok', message: 'Connection OK' });
  });

  describe('listDnsServers', () => {
    it('should return mapped servers without encrypted config', async () => {
      const db = createMockDb();
      const result = await listDnsServers(db);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: 'dns-1',
        displayName: 'Test PowerDNS',
        providerType: 'powerdns',
        zoneDefaultKind: 'Native',
        isDefault: true,
        enabled: true,
        lastHealthCheck: mockServer.lastHealthCheck,
        lastHealthStatus: 'ok',
        createdAt: mockServer.createdAt,
        updatedAt: mockServer.updatedAt,
      });
      // Must not contain connectionConfigEncrypted
      expect(result[0]).not.toHaveProperty('connectionConfigEncrypted');
    });
  });

  describe('getDnsServerById', () => {
    it('should return the server when found', async () => {
      const db = createMockDb();
      const result = await getDnsServerById(db, 'dns-1');

      expect(result.id).toBe('dns-1');
    });

    it('should throw DNS_SERVER_NOT_FOUND when not found', async () => {
      const db = createMockDb();

      await expect(getDnsServerById(db, 'nonexistent')).rejects.toThrow('not found');
    });
  });

  describe('createDnsServer', () => {
    it('should test connection, encrypt config, and insert', async () => {
      const { encrypt } = await import('../oidc/crypto.js');
      const { createProvider } = await import('./providers/index.js');

      const db = createMockDb();
      const input = {
        display_name: 'New Server',
        provider_type: 'cloudflare',
        connection_config: { api_token: 'cf-token' },
      };

      await createDnsServer(db, input, 'encryption-key');

      expect(createProvider).toHaveBeenCalledWith('cloudflare', { api_token: 'cf-token' });
      expect(mockTestConnection).toHaveBeenCalled();
      expect(encrypt).toHaveBeenCalledWith(
        JSON.stringify({ api_token: 'cf-token' }),
        'encryption-key',
      );
      expect(db.insert).toHaveBeenCalled();
    });

    it('should throw when connection test fails', async () => {
      mockTestConnection.mockResolvedValue({ status: 'error', message: 'Auth failed' });

      const db = createMockDb();
      const input = {
        display_name: 'Bad Server',
        provider_type: 'cloudflare',
        connection_config: { api_token: 'bad-token' },
      };

      await expect(createDnsServer(db, input, 'encryption-key')).rejects.toThrow(
        'Cannot connect to DNS server',
      );
    });
  });

  describe('deleteDnsServer', () => {
    it('should delete the server', async () => {
      const db = createMockDb();
      await deleteDnsServer(db, 'dns-1');

      expect(db.delete).toHaveBeenCalled();
    });

    it('should throw when server does not exist', async () => {
      const db = createMockDb();

      await expect(deleteDnsServer(db, 'nonexistent')).rejects.toThrow('not found');
    });
  });

  describe('testDnsServerConnection', () => {
    it('should decrypt config, create provider, and test connection', async () => {
      const { decrypt } = await import('../oidc/crypto.js');
      const { createProvider } = await import('./providers/index.js');

      const db = createMockDb();
      const result = await testDnsServerConnection(db, 'dns-1', 'encryption-key');

      expect(decrypt).toHaveBeenCalledWith('encrypted-config-data', 'encryption-key');
      expect(createProvider).toHaveBeenCalledWith('powerdns', { apiKey: 'test-key' });
      expect(result).toEqual({ status: 'ok', message: 'Connection OK' });
    });

    it('should update health status after testing', async () => {
      const db = createMockDb();
      await testDnsServerConnection(db, 'dns-1', 'encryption-key');

      expect(db.update).toHaveBeenCalled();
    });
  });

  describe('getProviderForServer', () => {
    it('should decrypt config and return provider adapter', async () => {
      const result = getProviderForServer(mockServer as never, 'encryption-key');

      expect(result).toBeDefined();
      expect(typeof result.testConnection).toBe('function');
    });
  });

  describe('getActiveServers', () => {
    it('should query for enabled servers', async () => {
      const db = createMockDb();
      const result = await getActiveServers(db);

      expect(db.select).toHaveBeenCalled();
      expect(Array.isArray(result)).toBe(true);
    });
  });
});
