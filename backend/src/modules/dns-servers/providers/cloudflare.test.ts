import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CloudflareDnsProvider } from './cloudflare.js';
import type { CloudflareConfig } from './types.js';

const config: CloudflareConfig = {
  api_token: 'cf-test-token',
};

function mockFetch(responses: Array<{ body?: unknown; success?: boolean; errors?: Array<{ message: string }> }>) {
  const calls: Array<{ url: string; options: RequestInit }> = [];
  let callIndex = 0;

  const fn = vi.fn(async (url: string | URL | Request, options: RequestInit = {}) => {
    calls.push({ url: String(url), options });
    const resp = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        success: resp.success ?? true,
        result: resp.body,
        errors: resp.errors ?? [],
      }),
      text: async () => JSON.stringify({ success: resp.success ?? true, result: resp.body, errors: resp.errors ?? [] }),
    } as Response;
  });

  return { fn, calls };
}

describe('CloudflareDnsProvider', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('testConnection', () => {
    it('should return ok when token is valid', async () => {
      const { fn, calls } = mockFetch([{ body: { id: 'token-id' } }]);
      globalThis.fetch = fn;

      const provider = new CloudflareDnsProvider(config);
      const result = await provider.testConnection();

      expect(result.status).toBe('ok');
      expect(result.version).toBe('v4');
      expect(calls[0].url).toContain('/user/tokens/verify');
      expect(calls[0].options.headers).toHaveProperty('Authorization', 'Bearer cf-test-token');
    });

    it('should return error on API failure', async () => {
      const { fn } = mockFetch([{ success: false, errors: [{ message: 'Invalid token' }] }]);
      globalThis.fetch = fn;

      const provider = new CloudflareDnsProvider(config);
      const result = await provider.testConnection();

      expect(result.status).toBe('error');
      expect(result.message).toContain('Invalid token');
    });
  });

  describe('listZones', () => {
    it('should list zones with trailing dots', async () => {
      const { fn } = mockFetch([{
        body: [
          { id: 'zone-1', name: 'example.com' },
          { id: 'zone-2', name: 'test.org' },
        ],
      }]);
      globalThis.fetch = fn;

      const provider = new CloudflareDnsProvider(config);
      const zones = await provider.listZones();

      expect(zones).toHaveLength(2);
      expect(zones[0].name).toBe('example.com.');
      expect(zones[0].kind).toBe('Native');
      expect(zones[1].name).toBe('test.org.');
    });
  });

  describe('getZone', () => {
    it('should find zone by name', async () => {
      const { fn, calls } = mockFetch([{
        body: [{ id: 'zone-1', name: 'example.com' }],
      }]);
      globalThis.fetch = fn;

      const provider = new CloudflareDnsProvider(config);
      const zone = await provider.getZone('example.com.');

      expect(zone).not.toBeNull();
      expect(zone!.name).toBe('example.com.');
      expect(calls[0].url).toContain('/zones?name=example.com');
    });

    it('should return null when zone not found', async () => {
      const { fn } = mockFetch([{ body: [] }]);
      globalThis.fetch = fn;

      const provider = new CloudflareDnsProvider(config);
      const zone = await provider.getZone('missing.com');

      expect(zone).toBeNull();
    });
  });

  describe('createZone', () => {
    it('should create a new zone', async () => {
      const { fn, calls } = mockFetch([
        // getZone check (empty = not found)
        { body: [] },
        // createZone POST
        { body: { id: 'zone-new', name: 'example.com' } },
      ]);
      globalThis.fetch = fn;

      const provider = new CloudflareDnsProvider(config);
      const zone = await provider.createZone('example.com', 'Native');

      expect(zone.name).toBe('example.com.');
      expect(calls[1].options.method).toBe('POST');
      const body = JSON.parse(calls[1].options.body as string);
      expect(body.name).toBe('example.com');
      expect(body.jump_start).toBe(false);
    });

    it('should return existing zone if already present', async () => {
      const { fn } = mockFetch([
        { body: [{ id: 'zone-1', name: 'example.com' }] },
      ]);
      globalThis.fetch = fn;

      const provider = new CloudflareDnsProvider(config);
      const zone = await provider.createZone('example.com', 'Native');

      expect(zone.name).toBe('example.com.');
    });
  });

  describe('deleteZone', () => {
    it('should look up zone id then send DELETE', async () => {
      const { fn, calls } = mockFetch([
        { body: [{ id: 'zone-1', name: 'example.com' }] },
        { body: { id: 'zone-1' } },
      ]);
      globalThis.fetch = fn;

      const provider = new CloudflareDnsProvider(config);
      await provider.deleteZone('example.com');

      expect(calls[1].options.method).toBe('DELETE');
      expect(calls[1].url).toContain('/zones/zone-1');
    });

    it('should do nothing when zone does not exist', async () => {
      const { fn, calls } = mockFetch([{ body: [] }]);
      globalThis.fetch = fn;

      const provider = new CloudflareDnsProvider(config);
      await provider.deleteZone('missing.com');

      expect(calls).toHaveLength(1);
    });
  });

  describe('listRecords', () => {
    it('should list records with trailing dots on names', async () => {
      const { fn } = mockFetch([
        // getZoneId
        { body: [{ id: 'zone-1', name: 'example.com' }] },
        // listRecords
        {
          body: [
            { id: 'rec-1', type: 'A', name: 'example.com', content: '1.2.3.4', ttl: 3600, priority: undefined },
            { id: 'rec-2', type: 'MX', name: 'example.com', content: 'mail.example.com', ttl: 3600, priority: 10 },
          ],
        },
      ]);
      globalThis.fetch = fn;

      const provider = new CloudflareDnsProvider(config);
      const records = await provider.listRecords('example.com');

      expect(records).toHaveLength(2);
      expect(records[0].name).toBe('example.com.');
      expect(records[0].content).toBe('1.2.3.4');
      expect(records[1].priority).toBe(10);
    });

    it('should throw when zone not found', async () => {
      const { fn } = mockFetch([{ body: [] }]);
      globalThis.fetch = fn;

      const provider = new CloudflareDnsProvider(config);
      await expect(provider.listRecords('missing.com')).rejects.toThrow("Zone 'missing.com' not found on Cloudflare");
    });
  });

  describe('createRecord', () => {
    it('should POST a new record', async () => {
      const { fn, calls } = mockFetch([
        { body: [{ id: 'zone-1', name: 'example.com' }] },
        { body: { id: 'rec-new', type: 'A', name: 'www.example.com', content: '1.2.3.4', ttl: 1 } },
      ]);
      globalThis.fetch = fn;

      const provider = new CloudflareDnsProvider(config);
      const record = await provider.createRecord('example.com', {
        type: 'A', name: 'www', content: '1.2.3.4',
      });

      expect(record.id).toBe('rec-new');
      expect(record.type).toBe('A');
      expect(record.name).toBe('www.example.com.');
      expect(calls[1].options.method).toBe('POST');
    });
  });

  describe('updateRecord', () => {
    it('should fetch existing then PATCH', async () => {
      const { fn, calls } = mockFetch([
        // getZoneId
        { body: [{ id: 'zone-1', name: 'example.com' }] },
        // fetch existing record
        { body: { id: 'rec-1', type: 'A', name: 'www.example.com', content: '1.2.3.4', ttl: 3600 } },
        // PATCH update
        { body: { id: 'rec-1', type: 'A', name: 'www.example.com', content: '5.6.7.8', ttl: 3600 } },
      ]);
      globalThis.fetch = fn;

      const provider = new CloudflareDnsProvider(config);
      const record = await provider.updateRecord('example.com', 'rec-1', { content: '5.6.7.8' });

      expect(record.content).toBe('5.6.7.8');
      expect(calls[2].options.method).toBe('PATCH');
    });
  });

  describe('deleteRecord', () => {
    it('should look up zone id then DELETE record', async () => {
      const { fn, calls } = mockFetch([
        { body: [{ id: 'zone-1', name: 'example.com' }] },
        { body: { id: 'rec-1' } },
      ]);
      globalThis.fetch = fn;

      const provider = new CloudflareDnsProvider(config);
      await provider.deleteRecord('example.com', 'rec-1');

      expect(calls[1].options.method).toBe('DELETE');
      expect(calls[1].url).toContain('/dns_records/rec-1');
    });
  });

  describe('network errors', () => {
    it('should propagate fetch errors', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const provider = new CloudflareDnsProvider(config);
      await expect(provider.listZones()).rejects.toThrow('Network error');
    });
  });
});
