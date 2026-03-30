import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Route53DnsProvider } from './route53.js';
import type { Route53Config } from './types.js';

const config: Route53Config = {
  access_key_id: 'AKIAIOSFODNN7EXAMPLE',
  secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  hosted_zone_id: 'Z1234567890',
};

function mockFetch(responses: Array<{ status: number; body?: string; statusText?: string }>) {
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
      json: async () => ({}),
      text: async () => resp.body ?? '',
    } as Response;
  });

  return { fn, calls };
}

describe('Route53DnsProvider', () => {
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
      const { fn, calls } = mockFetch([{
        status: 200,
        body: '<ListHostedZonesResponse><HostedZones></HostedZones></ListHostedZonesResponse>',
      }]);
      globalThis.fetch = fn;

      const provider = new Route53DnsProvider(config);
      const result = await provider.testConnection();

      expect(result.status).toBe('ok');
      expect(result.version).toBe('2013-04-01');
      expect(calls[0].url).toContain('/2013-04-01/hostedzone?maxitems=1');
    });

    it('should include AWS Signature V4 headers', async () => {
      const { fn, calls } = mockFetch([{ status: 200, body: '<ok/>' }]);
      globalThis.fetch = fn;

      const provider = new Route53DnsProvider(config);
      await provider.testConnection();

      const headers = calls[0].options.headers as Record<string, string>;
      expect(headers['Authorization']).toContain('AWS4-HMAC-SHA256');
      expect(headers['Authorization']).toContain('Credential=AKIAIOSFODNN7EXAMPLE');
      expect(headers['X-Amz-Date']).toBeDefined();
      expect(headers['Host']).toBe('route53.amazonaws.com');
    });

    it('should return error on failure', async () => {
      const { fn } = mockFetch([{ status: 403, statusText: 'Forbidden', body: 'Access Denied' }]);
      globalThis.fetch = fn;

      const provider = new Route53DnsProvider(config);
      const result = await provider.testConnection();

      expect(result.status).toBe('error');
      expect(result.message).toContain('Route53 API');
    });
  });

  describe('listZones', () => {
    it('should return empty array (stub implementation)', async () => {
      const provider = new Route53DnsProvider(config);
      const zones = await provider.listZones();

      expect(zones).toEqual([]);
    });
  });

  describe('getZone', () => {
    it('should return null (stub implementation)', async () => {
      const provider = new Route53DnsProvider(config);
      const zone = await provider.getZone('example.com');

      expect(zone).toBeNull();
    });
  });

  describe('createZone', () => {
    it('should POST CreateHostedZoneRequest XML', async () => {
      const { fn, calls } = mockFetch([{
        status: 201,
        body: '<CreateHostedZoneResponse><HostedZone><Id>/hostedzone/Z999</Id></HostedZone></CreateHostedZoneResponse>',
      }]);
      globalThis.fetch = fn;

      const provider = new Route53DnsProvider(config);
      const zone = await provider.createZone('example.com', 'Native');

      expect(zone.name).toBe('example.com.');
      expect(zone.kind).toBe('Native');
      expect(calls[0].options.method).toBe('POST');
      expect(calls[0].url).toContain('/2013-04-01/hostedzone');
      expect(calls[0].options.body).toContain('<Name>example.com.</Name>');
      expect(calls[0].options.body).toContain('<CallerReference>');
    });

    it('should throw on API error', async () => {
      const { fn } = mockFetch([{ status: 409, statusText: 'Conflict', body: 'HostedZoneAlreadyExists' }]);
      globalThis.fetch = fn;

      const provider = new Route53DnsProvider(config);
      await expect(provider.createZone('example.com', 'Native')).rejects.toThrow('Route53 API');
    });
  });

  describe('deleteZone', () => {
    it('should resolve without error (stub implementation)', async () => {
      const provider = new Route53DnsProvider(config);
      await expect(provider.deleteZone('example.com')).resolves.toBeUndefined();
    });
  });

  describe('listRecords', () => {
    it('should return empty array (stub implementation)', async () => {
      const provider = new Route53DnsProvider(config);
      const records = await provider.listRecords('example.com');

      expect(records).toEqual([]);
    });
  });

  describe('createRecord', () => {
    it('should POST UPSERT change batch XML', async () => {
      const { fn, calls } = mockFetch([{
        status: 200,
        body: '<ChangeResourceRecordSetsResponse></ChangeResourceRecordSetsResponse>',
      }]);
      globalThis.fetch = fn;

      const provider = new Route53DnsProvider(config);
      const record = await provider.createRecord('example.com', {
        type: 'A', name: 'www', content: '1.2.3.4', ttl: 300,
      });

      expect(record.type).toBe('A');
      expect(record.content).toBe('1.2.3.4');
      expect(record.ttl).toBe(300);
      expect(record.id).toBe('www.example.com.|A');
      expect(calls[0].options.method).toBe('POST');
      expect(calls[0].url).toContain(`/hostedzone/${config.hosted_zone_id}/rrset`);
      expect(calls[0].options.body).toContain('<Action>UPSERT</Action>');
      expect(calls[0].options.body).toContain('<Value>1.2.3.4</Value>');
    });

    it('should throw when hosted_zone_id is not configured', async () => {
      const noZoneConfig: Route53Config = {
        access_key_id: 'AKIAIOSFODNN7EXAMPLE',
        secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        region: 'us-east-1',
      };

      const provider = new Route53DnsProvider(noZoneConfig);
      await expect(provider.createRecord('example.com', {
        type: 'A', name: 'www', content: '1.2.3.4',
      })).rejects.toThrow('hosted_zone_id required');
    });
  });

  describe('updateRecord', () => {
    it('should delegate to createRecord (UPSERT)', async () => {
      const { fn } = mockFetch([{
        status: 200,
        body: '<ChangeResourceRecordSetsResponse></ChangeResourceRecordSetsResponse>',
      }]);
      globalThis.fetch = fn;

      const provider = new Route53DnsProvider(config);
      const record = await provider.updateRecord('example.com', 'www.example.com.|A', {
        type: 'A', name: 'www', content: '5.6.7.8',
      });

      expect(record.content).toBe('5.6.7.8');
    });

    it('should throw when partial input missing required fields', async () => {
      const provider = new Route53DnsProvider(config);
      await expect(provider.updateRecord('example.com', 'rec-1', {
        content: '5.6.7.8',
      })).rejects.toThrow('Full record required');
    });
  });

  describe('deleteRecord', () => {
    it('should throw when hosted_zone_id is not configured', async () => {
      const noZoneConfig: Route53Config = {
        access_key_id: 'AKIAIOSFODNN7EXAMPLE',
        secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        region: 'us-east-1',
      };

      const provider = new Route53DnsProvider(noZoneConfig);
      await expect(provider.deleteRecord('example.com', 'rec-1')).rejects.toThrow('hosted_zone_id required');
    });

    it('should resolve when hosted_zone_id is configured (stub)', async () => {
      const provider = new Route53DnsProvider(config);
      await expect(provider.deleteRecord('example.com', 'rec-1')).resolves.toBeUndefined();
    });
  });

  describe('network errors', () => {
    it('should propagate fetch errors in testConnection', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const provider = new Route53DnsProvider(config);
      const result = await provider.testConnection();

      expect(result.status).toBe('error');
      expect(result.message).toContain('Network error');
    });

    it('should propagate fetch errors in createZone', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('DNS resolution failed'));

      const provider = new Route53DnsProvider(config);
      await expect(provider.createZone('example.com', 'Native')).rejects.toThrow('DNS resolution failed');
    });
  });
});
