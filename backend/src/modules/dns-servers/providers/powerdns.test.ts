import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PowerDnsProvider } from './powerdns.js';
import type { PowerDnsConfig } from './types.js';

const config: PowerDnsConfig = {
  api_url: 'http://pdns.local:8081',
  api_key: 'test-api-key',
  server_id: 'localhost',
  api_version: 'v4',
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

describe('PowerDnsProvider', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('testConnection', () => {
    it('should return ok with version on success', async () => {
      const { fn } = mockFetch([{ status: 200, body: { version: '4.8.0', daemon_type: 'authoritative' } }]);
      globalThis.fetch = fn;

      const provider = new PowerDnsProvider(config);
      const result = await provider.testConnection();

      expect(result.status).toBe('ok');
      expect(result.version).toBe('4.8.0');
      expect(result.message).toContain('authoritative');
    });

    it('should return error on failure', async () => {
      const { fn } = mockFetch([{ status: 500, statusText: 'Internal Server Error', body: 'server error' }]);
      globalThis.fetch = fn;

      const provider = new PowerDnsProvider(config);
      const result = await provider.testConnection();

      expect(result.status).toBe('error');
      expect(result.message).toBeDefined();
    });
  });

  describe('listZones', () => {
    it('should list zones and transform response', async () => {
      const { fn, calls } = mockFetch([{
        status: 200,
        body: [
          { name: 'example.com.', kind: 'Native', serial: 2024010101 },
          { name: 'test.org.', kind: 'Master', serial: 2024010102 },
        ],
      }]);
      globalThis.fetch = fn;

      const provider = new PowerDnsProvider(config);
      const zones = await provider.listZones();

      expect(zones).toHaveLength(2);
      expect(zones[0].name).toBe('example.com.');
      expect(zones[0].kind).toBe('Native');
      expect(zones[1].name).toBe('test.org.');
      expect(calls[0].url).toBe('http://pdns.local:8081/api/v1/servers/localhost/zones');
      expect(calls[0].options.headers).toHaveProperty('X-API-Key', 'test-api-key');
    });
  });

  describe('getZone', () => {
    it('should get zone by name (normalizes trailing dot)', async () => {
      const { fn, calls } = mockFetch([{
        status: 200,
        body: { name: 'example.com.', kind: 'Native', serial: 2024010101 },
      }]);
      globalThis.fetch = fn;

      const provider = new PowerDnsProvider(config);
      const zone = await provider.getZone('example.com');

      expect(zone).not.toBeNull();
      expect(zone!.name).toBe('example.com.');
      expect(calls[0].url).toContain('/zones/example.com.');
    });

    it('should return null for non-existent zone', async () => {
      const { fn } = mockFetch([{ status: 404, statusText: 'Not Found', body: 'not found' }]);
      globalThis.fetch = fn;

      const provider = new PowerDnsProvider(config);
      const zone = await provider.getZone('missing.com');

      expect(zone).toBeNull();
    });
  });

  describe('createZone', () => {
    it('should create a new zone', async () => {
      const { fn, calls } = mockFetch([
        // getZone check (404 = not found)
        { status: 404, statusText: 'Not Found', body: 'not found' },
        // createZone POST
        { status: 201, body: { name: 'example.com.', kind: 'Native', serial: 1 } },
      ]);
      globalThis.fetch = fn;

      const provider = new PowerDnsProvider(config);
      const zone = await provider.createZone('example.com', 'Native');

      expect(zone.name).toBe('example.com.');
      expect(zone.kind).toBe('Native');
      // First call is getZone, second is POST
      expect(calls[1].options.method).toBe('POST');
      const body = JSON.parse(calls[1].options.body as string);
      expect(body.name).toBe('example.com.');
      expect(body.kind).toBe('Native');
      expect(body.nameservers).toEqual(['ns1.example.com.', 'ns2.example.com.']);
    });

    it('should return existing zone if it already exists', async () => {
      const { fn } = mockFetch([
        { status: 200, body: { name: 'example.com.', kind: 'Native', serial: 100 } },
      ]);
      globalThis.fetch = fn;

      const provider = new PowerDnsProvider(config);
      const zone = await provider.createZone('example.com', 'Native');

      expect(zone.name).toBe('example.com.');
      expect(zone.serial).toBe(100);
    });
  });

  describe('deleteZone', () => {
    it('should send DELETE request with normalized name', async () => {
      const { fn, calls } = mockFetch([{ status: 204 }]);
      globalThis.fetch = fn;

      const provider = new PowerDnsProvider(config);
      await provider.deleteZone('example.com');

      expect(calls[0].options.method).toBe('DELETE');
      expect(calls[0].url).toContain('/zones/example.com.');
    });

    it('should throw on API error', async () => {
      const { fn } = mockFetch([{ status: 500, statusText: 'Internal Server Error', body: 'server error' }]);
      globalThis.fetch = fn;

      const provider = new PowerDnsProvider(config);
      await expect(provider.deleteZone('example.com')).rejects.toThrow('PowerDNS API error');
    });
  });

  describe('listRecords', () => {
    it('should flatten rrsets into individual records', async () => {
      const { fn } = mockFetch([{
        status: 200,
        body: {
          name: 'example.com.',
          kind: 'Native',
          serial: 1,
          rrsets: [
            { name: 'example.com.', type: 'A', ttl: 3600, records: [{ content: '1.2.3.4', disabled: false }] },
            { name: 'mail.example.com.', type: 'MX', ttl: 3600, records: [{ content: '10 mail.example.com.', disabled: false }] },
          ],
        },
      }]);
      globalThis.fetch = fn;

      const provider = new PowerDnsProvider(config);
      const records = await provider.listRecords('example.com');

      expect(records).toHaveLength(2);
      expect(records[0].type).toBe('A');
      expect(records[0].content).toBe('1.2.3.4');
      expect(records[0].id).toBe('example.com.|A|1.2.3.4');
      expect(records[1].type).toBe('MX');
      expect(records[1].priority).toBe(10);
    });
  });

  describe('createRecord', () => {
    it('should PATCH rrsets to create a record', async () => {
      // First call (GET zone) returns empty rrsets, second call (PATCH) succeeds
      const { fn, calls } = mockFetch([
        { status: 200, body: { rrsets: [] } },
        { status: 204 },
      ]);
      globalThis.fetch = fn;

      const provider = new PowerDnsProvider(config);
      const record = await provider.createRecord('example.com', {
        type: 'A', name: 'www', content: '1.2.3.4', ttl: 300,
      });

      expect(record.type).toBe('A');
      expect(record.content).toBe('1.2.3.4');
      expect(record.ttl).toBe(300);
      // calls[0] is GET (fetch existing rrsets), calls[1] is PATCH
      expect(calls[1].options.method).toBe('PATCH');
      const body = JSON.parse(calls[1].options.body as string);
      expect(body.rrsets[0].changetype).toBe('REPLACE');
    });

    it('should format MX records with priority', async () => {
      const { fn, calls } = mockFetch([
        { status: 200, body: { rrsets: [] } },
        { status: 204 },
      ]);
      globalThis.fetch = fn;

      const provider = new PowerDnsProvider(config);
      await provider.createRecord('example.com', {
        type: 'MX', name: 'mail', content: 'mail.example.com.', priority: 10,
      });

      const body = JSON.parse(calls[1].options.body as string);
      expect(body.rrsets[0].records[0].content).toBe('10 mail.example.com.');
    });
  });

  describe('updateRecord', () => {
    it('should PATCH to update a record', async () => {
      const { fn, calls } = mockFetch([{ status: 204 }]);
      globalThis.fetch = fn;

      const provider = new PowerDnsProvider(config);
      const updated = await provider.updateRecord('example.com', 'www.example.com.|A|1.2.3.4', {
        content: '5.6.7.8',
      });

      expect(updated.content).toBe('5.6.7.8');
      expect(calls[0].options.method).toBe('PATCH');
    });
  });

  describe('deleteRecord', () => {
    it('should PATCH with DELETE changetype', async () => {
      const { fn, calls } = mockFetch([{ status: 204 }]);
      globalThis.fetch = fn;

      const provider = new PowerDnsProvider(config);
      await provider.deleteRecord('example.com', 'www.example.com.|A|1.2.3.4');

      expect(calls[0].options.method).toBe('PATCH');
      const body = JSON.parse(calls[0].options.body as string);
      expect(body.rrsets[0].changetype).toBe('DELETE');
      expect(body.rrsets[0].name).toBe('www.example.com.');
      expect(body.rrsets[0].type).toBe('A');
    });
  });

  describe('createSlaveZone', () => {
    it('should create a slave zone with master IP', async () => {
      const { fn, calls } = mockFetch([
        { status: 404, statusText: 'Not Found', body: 'not found' },
        { status: 201, body: { name: 'example.com.', kind: 'Slave', serial: 0 } },
      ]);
      globalThis.fetch = fn;

      const provider = new PowerDnsProvider(config);
      const zone = await provider.createSlaveZone('example.com', '10.0.0.1');

      expect(zone.kind).toBe('Slave');
      const body = JSON.parse(calls[1].options.body as string);
      expect(body.kind).toBe('Slave');
      expect(body.masters).toEqual(['10.0.0.1']);
    });
  });

  describe('getZoneAxfrStatus', () => {
    it('should parse SOA serial from zone data', async () => {
      const { fn } = mockFetch([{
        status: 200,
        body: {
          name: 'example.com.',
          kind: 'Slave',
          serial: 0,
          rrsets: [
            { name: 'example.com.', type: 'SOA', ttl: 3600, records: [{ content: 'ns1.example.com. admin.example.com. 2024010101 3600 900 604800 86400', disabled: false }] },
          ],
        },
      }]);
      globalThis.fetch = fn;

      const provider = new PowerDnsProvider(config);
      const status = await provider.getZoneAxfrStatus('example.com');

      expect(status.synced).toBe(true);
      expect(status.lastSoaSerial).toBe(2024010101);
    });

    it('should return synced false on error', async () => {
      const { fn } = mockFetch([{ status: 404, statusText: 'Not Found', body: 'not found' }]);
      globalThis.fetch = fn;

      const provider = new PowerDnsProvider(config);
      const status = await provider.getZoneAxfrStatus('missing.com');

      expect(status.synced).toBe(false);
    });
  });

  describe('network errors', () => {
    it('should propagate fetch errors', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const provider = new PowerDnsProvider(config);
      await expect(provider.listZones()).rejects.toThrow('Network error');
    });
  });
});
