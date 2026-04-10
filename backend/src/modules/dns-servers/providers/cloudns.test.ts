import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClouDnsProvider } from './cloudns.js';
import type { ClouDnsConfig } from './types.js';

const config: ClouDnsConfig = {
  auth_id: '1234',
  auth_password: 'test-password',
};

function mockFetch(responses: Array<{ status: number; body?: unknown; statusText?: string }>) {
  const calls: Array<{ url: string; options: RequestInit }> = [];
  let callIndex = 0;

  const fn = vi.fn(async (url: string | URL | Request, options: RequestInit = {}) => {
    calls.push({ url: String(url), options });
    const resp = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      statusText: resp.statusText ?? 'OK',
      json: async () => resp.body,
      text: async () => typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body),
    } as Response;
  });

  return { fn, calls };
}

describe('ClouDnsProvider', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should use auth-id when auth_id is provided', async () => {
      const { fn, calls } = mockFetch([{ status: 200, body: { status: 'Success' } }]);
      globalThis.fetch = fn;

      const provider = new ClouDnsProvider(config);
      await provider.testConnection();

      expect(calls[0].url).toContain('auth-id=1234');
      expect(calls[0].url).toContain('auth-password=test-password');
    });

    it('should use sub-auth-id when sub_auth_id is provided', async () => {
      const { fn, calls } = mockFetch([{ status: 200, body: { status: 'Success' } }]);
      globalThis.fetch = fn;

      const provider = new ClouDnsProvider({
        sub_auth_id: '5678',
        auth_password: 'sub-password',
      });
      await provider.testConnection();

      expect(calls[0].url).toContain('sub-auth-id=5678');
      expect(calls[0].url).not.toMatch(/(?<!sub-)auth-id=/);
    });

    it('should use custom api_url when provided', async () => {
      const { fn, calls } = mockFetch([{ status: 200, body: { status: 'Success' } }]);
      globalThis.fetch = fn;

      const provider = new ClouDnsProvider({
        auth_id: '1234',
        auth_password: 'test-password',
        api_url: 'https://custom.cloudns.net',
      });
      await provider.testConnection();

      expect(calls[0].url).toMatch(/^https:\/\/custom\.cloudns\.net\//);
    });
  });

  describe('testConnection', () => {
    it('should return ok on successful login', async () => {
      const { fn, calls } = mockFetch([{ status: 200, body: { status: 'Success' } }]);
      globalThis.fetch = fn;

      const provider = new ClouDnsProvider(config);
      const result = await provider.testConnection();

      expect(result.status).toBe('ok');
      expect(result.version).toBe('v1');
      expect(calls[0].url).toContain('/dns/login.json');
    });

    it('should return error on failed login', async () => {
      const { fn } = mockFetch([{ status: 200, body: { status: 'Failed', statusDescription: 'Invalid credentials' } }]);
      globalThis.fetch = fn;

      const provider = new ClouDnsProvider(config);
      const result = await provider.testConnection();

      expect(result.status).toBe('error');
      expect(result.message).toContain('Invalid credentials');
    });

    it('should return error on HTTP failure', async () => {
      const { fn } = mockFetch([{ status: 401, statusText: 'Unauthorized', body: 'unauthorized' }]);
      globalThis.fetch = fn;

      const provider = new ClouDnsProvider(config);
      const result = await provider.testConnection();

      expect(result.status).toBe('error');
      expect(result.message).toBeDefined();
    });
  });

  describe('listZones', () => {
    it('should list zones with trailing dots', async () => {
      const { fn } = mockFetch([{
        status: 200,
        body: {
          'example.com': { name: 'example.com', type: 'master' },
          'test.org': { name: 'test.org', type: 'master' },
        },
      }]);
      globalThis.fetch = fn;

      const provider = new ClouDnsProvider(config);
      const zones = await provider.listZones();

      expect(zones).toHaveLength(2);
      expect(zones[0].name).toBe('example.com.');
      expect(zones[0].kind).toBe('Native');
      expect(zones[1].name).toBe('test.org.');
    });

    it('should return empty array when no zones exist', async () => {
      const { fn } = mockFetch([{ status: 200, body: [] }]);
      globalThis.fetch = fn;

      const provider = new ClouDnsProvider(config);
      const zones = await provider.listZones();

      expect(zones).toHaveLength(0);
    });

    it('should include pagination params in request', async () => {
      const { fn, calls } = mockFetch([{ status: 200, body: [] }]);
      globalThis.fetch = fn;

      const provider = new ClouDnsProvider(config);
      await provider.listZones();

      expect(calls[0].url).toContain('page=1');
      expect(calls[0].url).toContain('rows-per-page=100');
    });
  });

  describe('getZone', () => {
    it('should find zone by name', async () => {
      const { fn, calls } = mockFetch([{
        status: 200,
        body: { name: 'example.com', type: 'master', zone: 'master' },
      }]);
      globalThis.fetch = fn;

      const provider = new ClouDnsProvider(config);
      const zone = await provider.getZone('example.com.');

      expect(zone).not.toBeNull();
      expect(zone!.name).toBe('example.com.');
      expect(calls[0].url).toContain('domain-name=example.com');
    });

    it('should return null when zone not found', async () => {
      const { fn } = mockFetch([{
        status: 200,
        body: { status: 'Failed', statusDescription: 'Zone not found' },
      }]);
      globalThis.fetch = fn;

      const provider = new ClouDnsProvider(config);
      const zone = await provider.getZone('missing.com');

      expect(zone).toBeNull();
    });
  });

  describe('createZone', () => {
    it('should create a new zone', async () => {
      const { fn, calls } = mockFetch([
        // getZone check (not found)
        { status: 200, body: { status: 'Failed', statusDescription: 'Zone not found' } },
        // register zone
        { status: 200, body: { status: 'Success', statusDescription: 'Zone created' } },
      ]);
      globalThis.fetch = fn;

      const provider = new ClouDnsProvider(config);
      const zone = await provider.createZone('example.com', 'Native');

      expect(zone.name).toBe('example.com.');
      expect(calls[1].url).toContain('/dns/register.json');
      expect(calls[1].url).toContain('domain-name=example.com');
      expect(calls[1].url).toContain('zone-type=master');
    });

    it('should return existing zone if already present', async () => {
      const { fn } = mockFetch([
        { status: 200, body: { name: 'example.com', type: 'master', zone: 'master' } },
      ]);
      globalThis.fetch = fn;

      const provider = new ClouDnsProvider(config);
      const zone = await provider.createZone('example.com', 'Native');

      expect(zone.name).toBe('example.com.');
    });
  });

  describe('deleteZone', () => {
    it('should send delete request with domain name', async () => {
      const { fn, calls } = mockFetch([
        { status: 200, body: { status: 'Success' } },
      ]);
      globalThis.fetch = fn;

      const provider = new ClouDnsProvider(config);
      await provider.deleteZone('example.com.');

      expect(calls[0].url).toContain('/dns/delete.json');
      expect(calls[0].url).toContain('domain-name=example.com');
    });
  });

  describe('listRecords', () => {
    it('should list records for a zone', async () => {
      const { fn, calls } = mockFetch([{
        status: 200,
        body: {
          '100': { type: 'A', host: '', record: '1.2.3.4', ttl: '3600' },
          '101': { type: 'CNAME', host: 'www', record: 'example.com', ttl: '3600' },
          '102': { type: 'MX', host: '', record: 'mail.example.com', ttl: '3600', priority: '10' },
        },
      }]);
      globalThis.fetch = fn;

      const provider = new ClouDnsProvider(config);
      const records = await provider.listRecords('example.com');

      expect(records).toHaveLength(3);
      expect(records[0].id).toBe('100');
      expect(records[0].type).toBe('A');
      expect(records[0].name).toBe('example.com.');
      expect(records[0].content).toBe('1.2.3.4');
      expect(records[0].ttl).toBe(3600);
      expect(records[1].name).toBe('www.example.com.');
      expect(records[2].priority).toBe(10);
      expect(calls[0].url).toContain('domain-name=example.com');
    });

    it('should return empty array when no records exist', async () => {
      const { fn } = mockFetch([{ status: 200, body: [] }]);
      globalThis.fetch = fn;

      const provider = new ClouDnsProvider(config);
      const records = await provider.listRecords('example.com');

      expect(records).toHaveLength(0);
    });
  });

  describe('createRecord', () => {
    it('should POST a new record with correct params', async () => {
      const { fn, calls } = mockFetch([{
        status: 200,
        body: { status: 'Success', data: { id: 200 } },
      }]);
      globalThis.fetch = fn;

      const provider = new ClouDnsProvider(config);
      const record = await provider.createRecord('example.com', {
        type: 'A', name: 'www.example.com', content: '1.2.3.4', ttl: 3600,
      });

      expect(record.id).toBe('200');
      expect(record.type).toBe('A');
      expect(record.name).toBe('www.example.com.');
      expect(record.content).toBe('1.2.3.4');
      expect(calls[0].options.method).toBe('POST');
      expect(calls[0].url).toContain('domain-name=example.com');
      expect(calls[0].url).toContain('record-type=A');
      expect(calls[0].url).toContain('host=www');
      expect(calls[0].url).toContain('record=1.2.3.4');
      expect(calls[0].url).toContain('ttl=3600');
    });

    it('should include priority for MX records', async () => {
      const { fn, calls } = mockFetch([{
        status: 200,
        body: { status: 'Success', data: { id: 201 } },
      }]);
      globalThis.fetch = fn;

      const provider = new ClouDnsProvider(config);
      await provider.createRecord('example.com', {
        type: 'MX', name: 'example.com', content: 'mail.example.com', ttl: 3600, priority: 10,
      });

      expect(calls[0].url).toContain('priority=10');
    });

    it('should handle root-level records (empty host)', async () => {
      const { fn } = mockFetch([{
        status: 200,
        body: { status: 'Success', data: { id: 202 } },
      }]);
      globalThis.fetch = fn;

      const provider = new ClouDnsProvider(config);
      const record = await provider.createRecord('example.com', {
        type: 'A', name: 'example.com', content: '1.2.3.4',
      });

      expect(record.name).toBe('example.com.');
    });
  });

  describe('updateRecord', () => {
    it('should POST mod-record with correct params', async () => {
      const { fn, calls } = mockFetch([{
        status: 200,
        body: { status: 'Success' },
      }]);
      globalThis.fetch = fn;

      const provider = new ClouDnsProvider(config);
      const record = await provider.updateRecord('example.com', '100', {
        type: 'A', name: 'www.example.com', content: '5.6.7.8', ttl: 300,
      });

      expect(record.id).toBe('100');
      expect(record.content).toBe('5.6.7.8');
      expect(calls[0].options.method).toBe('POST');
      expect(calls[0].url).toContain('/dns/mod-record.json');
      expect(calls[0].url).toContain('record-id=100');
      expect(calls[0].url).toContain('record=5.6.7.8');
    });
  });

  describe('deleteRecord', () => {
    it('should POST delete-record with domain and record id', async () => {
      const { fn, calls } = mockFetch([{
        status: 200,
        body: { status: 'Success' },
      }]);
      globalThis.fetch = fn;

      const provider = new ClouDnsProvider(config);
      await provider.deleteRecord('example.com', '100');

      expect(calls[0].options.method).toBe('POST');
      expect(calls[0].url).toContain('/dns/delete-record.json');
      expect(calls[0].url).toContain('domain-name=example.com');
      expect(calls[0].url).toContain('record-id=100');
    });
  });

  describe('error handling', () => {
    it('should propagate fetch errors', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const provider = new ClouDnsProvider(config);
      await expect(provider.listZones()).rejects.toThrow('Network error');
    });

    it('should throw on non-ok HTTP status', async () => {
      const { fn } = mockFetch([{ status: 500, statusText: 'Internal Server Error', body: 'server down' }]);
      globalThis.fetch = fn;

      const provider = new ClouDnsProvider(config);
      await expect(provider.listZones()).rejects.toThrow('ClouDNS API: 500');
    });

    it('should throw on ClouDNS logical error status', async () => {
      const { fn } = mockFetch([{
        status: 200,
        body: { status: 'Failed', statusDescription: 'Rate limit exceeded' },
      }]);
      globalThis.fetch = fn;

      const provider = new ClouDnsProvider(config);
      await expect(provider.deleteZone('example.com')).rejects.toThrow('ClouDNS API: Rate limit exceeded');
    });
  });
});
