import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HetznerDnsProvider } from './hetzner.js';
import type { HetznerDnsConfig } from './types.js';

const config: HetznerDnsConfig = {
  api_token: 'hetzner-test-token',
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

describe('HetznerDnsProvider', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('testConnection', () => {
    it('should return ok on success', async () => {
      const { fn, calls } = mockFetch([{ status: 200, body: { zones: [] } }]);
      globalThis.fetch = fn;

      const provider = new HetznerDnsProvider(config);
      const result = await provider.testConnection();

      expect(result.status).toBe('ok');
      expect(result.version).toBe('v1');
      expect(calls[0].url).toContain('/zones?per_page=1');
      expect(calls[0].options.headers).toHaveProperty('Auth-API-Token', 'hetzner-test-token');
    });

    it('should return error on API failure', async () => {
      const { fn } = mockFetch([{ status: 401, statusText: 'Unauthorized', body: 'unauthorized' }]);
      globalThis.fetch = fn;

      const provider = new HetznerDnsProvider(config);
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
          zones: [
            { id: 'z1', name: 'example.com', records_count: 5 },
            { id: 'z2', name: 'test.org', records_count: 3 },
          ],
        },
      }]);
      globalThis.fetch = fn;

      const provider = new HetznerDnsProvider(config);
      const zones = await provider.listZones();

      expect(zones).toHaveLength(2);
      expect(zones[0].name).toBe('example.com.');
      expect(zones[0].kind).toBe('Native');
      expect(zones[0].records_count).toBe(5);
    });
  });

  describe('getZone', () => {
    it('should find zone by name', async () => {
      const { fn, calls } = mockFetch([{
        status: 200,
        body: { zones: [{ id: 'z1', name: 'example.com', records_count: 5 }] },
      }]);
      globalThis.fetch = fn;

      const provider = new HetznerDnsProvider(config);
      const zone = await provider.getZone('example.com.');

      expect(zone).not.toBeNull();
      expect(zone!.name).toBe('example.com.');
      expect(calls[0].url).toContain('/zones?name=example.com');
    });

    it('should return null when not found', async () => {
      const { fn } = mockFetch([{ status: 200, body: { zones: [] } }]);
      globalThis.fetch = fn;

      const provider = new HetznerDnsProvider(config);
      const zone = await provider.getZone('missing.com');

      expect(zone).toBeNull();
    });
  });

  describe('createZone', () => {
    it('should create a new zone', async () => {
      const { fn, calls } = mockFetch([
        // getZone check
        { status: 200, body: { zones: [] } },
        // POST create
        { status: 200, body: { zone: { id: 'z-new', name: 'example.com' } } },
      ]);
      globalThis.fetch = fn;

      const provider = new HetznerDnsProvider(config);
      const zone = await provider.createZone('example.com', 'Native');

      expect(zone.name).toBe('example.com.');
      expect(calls[1].options.method).toBe('POST');
      const body = JSON.parse(calls[1].options.body as string);
      expect(body.name).toBe('example.com');
      expect(body.ttl).toBe(3600);
    });

    it('should return existing zone', async () => {
      const { fn } = mockFetch([
        { status: 200, body: { zones: [{ id: 'z1', name: 'example.com', records_count: 5 }] } },
      ]);
      globalThis.fetch = fn;

      const provider = new HetznerDnsProvider(config);
      const zone = await provider.createZone('example.com', 'Native');

      expect(zone.name).toBe('example.com.');
      expect(zone.records_count).toBe(5);
    });
  });

  describe('deleteZone', () => {
    it('should look up zone id then DELETE', async () => {
      const { fn, calls } = mockFetch([
        { status: 200, body: { zones: [{ id: 'z1', name: 'example.com' }] } },
        { status: 204 },
      ]);
      globalThis.fetch = fn;

      const provider = new HetznerDnsProvider(config);
      await provider.deleteZone('example.com');

      expect(calls[1].options.method).toBe('DELETE');
      expect(calls[1].url).toContain('/zones/z1');
    });

    it('should do nothing when zone does not exist', async () => {
      const { fn, calls } = mockFetch([
        { status: 200, body: { zones: [] } },
      ]);
      globalThis.fetch = fn;

      const provider = new HetznerDnsProvider(config);
      await provider.deleteZone('missing.com');

      expect(calls).toHaveLength(1);
    });
  });

  describe('listRecords', () => {
    it('should list records for a zone', async () => {
      const { fn } = mockFetch([
        // getZoneId
        { status: 200, body: { zones: [{ id: 'z1', name: 'example.com' }] } },
        // listRecords
        {
          status: 200,
          body: {
            records: [
              { id: 'r1', type: 'A', name: '@', value: '1.2.3.4', ttl: 3600 },
              { id: 'r2', type: 'CNAME', name: 'www', value: 'example.com', ttl: 3600 },
            ],
          },
        },
      ]);
      globalThis.fetch = fn;

      const provider = new HetznerDnsProvider(config);
      const records = await provider.listRecords('example.com');

      expect(records).toHaveLength(2);
      expect(records[0].id).toBe('r1');
      expect(records[0].content).toBe('1.2.3.4');
      expect(records[1].type).toBe('CNAME');
    });

    it('should throw when zone not found', async () => {
      const { fn } = mockFetch([
        { status: 200, body: { zones: [] } },
      ]);
      globalThis.fetch = fn;

      const provider = new HetznerDnsProvider(config);
      await expect(provider.listRecords('missing.com')).rejects.toThrow("Zone 'missing.com' not found on Hetzner DNS");
    });
  });

  describe('createRecord', () => {
    it('should POST a new record', async () => {
      const { fn, calls } = mockFetch([
        { status: 200, body: { zones: [{ id: 'z1', name: 'example.com' }] } },
        { status: 200, body: { record: { id: 'r-new', type: 'A', name: '@', value: '1.2.3.4', ttl: 3600 } } },
      ]);
      globalThis.fetch = fn;

      const provider = new HetznerDnsProvider(config);
      const record = await provider.createRecord('example.com', {
        type: 'A', name: '@', content: '1.2.3.4', ttl: 3600,
      });

      expect(record.id).toBe('r-new');
      expect(record.content).toBe('1.2.3.4');
      expect(calls[1].options.method).toBe('POST');
      const body = JSON.parse(calls[1].options.body as string);
      expect(body.zone_id).toBe('z1');
      expect(body.value).toBe('1.2.3.4');
    });
  });

  describe('updateRecord', () => {
    it('should PUT to update a record', async () => {
      const { fn, calls } = mockFetch([
        { status: 200, body: { zones: [{ id: 'z1', name: 'example.com' }] } },
        { status: 200, body: { record: { id: 'r1', type: 'A', name: '@', value: '5.6.7.8', ttl: 300 } } },
      ]);
      globalThis.fetch = fn;

      const provider = new HetznerDnsProvider(config);
      const record = await provider.updateRecord('example.com', 'r1', {
        type: 'A', name: '@', content: '5.6.7.8', ttl: 300,
      });

      expect(record.content).toBe('5.6.7.8');
      expect(calls[1].options.method).toBe('PUT');
      expect(calls[1].url).toContain('/records/r1');
    });
  });

  describe('deleteRecord', () => {
    it('should DELETE record by id', async () => {
      const { fn, calls } = mockFetch([{ status: 204 }]);
      globalThis.fetch = fn;

      const provider = new HetznerDnsProvider(config);
      await provider.deleteRecord('example.com', 'r1');

      expect(calls[0].options.method).toBe('DELETE');
      expect(calls[0].url).toContain('/records/r1');
    });
  });

  describe('network errors', () => {
    it('should propagate fetch errors', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const provider = new HetznerDnsProvider(config);
      await expect(provider.listZones()).rejects.toThrow('Network error');
    });

    it('should throw on non-ok HTTP status', async () => {
      const { fn } = mockFetch([{ status: 500, statusText: 'Internal Server Error', body: 'server down' }]);
      globalThis.fetch = fn;

      const provider = new HetznerDnsProvider(config);
      await expect(provider.listZones()).rejects.toThrow('Hetzner DNS API: 500');
    });
  });
});
