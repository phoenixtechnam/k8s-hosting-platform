import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RndcDnsProvider } from './rndc.js';
import type { RndcConfig } from './types.js';

// Mock child_process before importing anything that uses it
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';

const config: RndcConfig = {
  server_host: '10.0.0.1',
  rndc_port: 953,
  rndc_key_name: 'rndc-key',
  rndc_key_algorithm: 'hmac-sha256',
  rndc_key_secret: 'base64secret==',
};

function mockExecSuccess(stdout: string) {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_cmd: string, _args: string[], callback: (err: Error | null, result: { stdout: string }) => void) => {
      callback(null, { stdout });
    },
  );
}

function mockExecError(message: string) {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_cmd: string, _args: string[], callback: (err: Error | null, result: { stdout: string }) => void) => {
      callback(new Error(message), { stdout: '' });
    },
  );
}

function getExecCalls(): Array<{ cmd: string; args: string[] }> {
  return (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
    (call: [string, string[], unknown]) => ({
      cmd: call[0],
      args: call[1],
    }),
  );
}

describe('RndcDnsProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('testConnection', () => {
    it('should return ok with BIND version', async () => {
      mockExecSuccess('version: BIND 9.18.24\nrunning on localhost\n');

      const provider = new RndcDnsProvider(config);
      const result = await provider.testConnection();

      expect(result.status).toBe('ok');
      expect(result.version).toBe('BIND 9.18.24');

      const calls = getExecCalls();
      expect(calls[0].cmd).toBe('rndc');
      expect(calls[0].args).toContain('-s');
      expect(calls[0].args).toContain('10.0.0.1');
      expect(calls[0].args).toContain('status');
    });

    it('should pass correct rndc key arguments', async () => {
      mockExecSuccess('version: BIND 9.18.24\n');

      const provider = new RndcDnsProvider(config);
      await provider.testConnection();

      const calls = getExecCalls();
      const args = calls[0].args;
      expect(args).toContain('-s');
      expect(args).toContain('10.0.0.1');
      expect(args).toContain('-p');
      expect(args).toContain('953');
      expect(args).toContain('-y');
      expect(args).toContain('hmac-sha256:rndc-key:base64secret==');
    });

    it('should return error when rndc fails', async () => {
      mockExecError('rndc: connect failed: connection refused');

      const provider = new RndcDnsProvider(config);
      const result = await provider.testConnection();

      expect(result.status).toBe('error');
      expect(result.message).toContain('connection refused');
    });
  });

  describe('listZones', () => {
    it('should parse zone names from zonestatus output', async () => {
      mockExecSuccess('name: example.com.\nserial: 2024010101\nname: test.org.\nserial: 2024010102\n');

      const provider = new RndcDnsProvider(config);
      const zones = await provider.listZones();

      expect(zones).toHaveLength(2);
      expect(zones[0].name).toBe('example.com.');
      expect(zones[0].kind).toBe('Master');
      expect(zones[1].name).toBe('test.org.');
    });

    it('should return empty array on error', async () => {
      mockExecError('rndc: not found');

      const provider = new RndcDnsProvider(config);
      const zones = await provider.listZones();

      expect(zones).toEqual([]);
    });
  });

  describe('getZone', () => {
    it('should find zone by name', async () => {
      mockExecSuccess('name: example.com.\nserial: 1\n');

      const provider = new RndcDnsProvider(config);
      const zone = await provider.getZone('example.com');

      expect(zone).not.toBeNull();
      expect(zone!.name).toBe('example.com.');
    });

    it('should return null for non-existent zone', async () => {
      mockExecSuccess('name: other.com.\nserial: 1\n');

      const provider = new RndcDnsProvider(config);
      const zone = await provider.getZone('missing.com');

      expect(zone).toBeNull();
    });
  });

  describe('createZone', () => {
    it('should call rndc addzone', async () => {
      // First call: listZones (for getZone check) — no matching zone
      // Second call: addzone
      let callCount = 0;
      (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (_cmd: string, args: string[], callback: (err: Error | null, result: { stdout: string }) => void) => {
          callCount++;
          if (args.includes('zonestatus')) {
            callback(null, { stdout: '' });
          } else {
            callback(null, { stdout: '' });
          }
        },
      );

      const provider = new RndcDnsProvider(config);
      const zone = await provider.createZone('example.com', 'Master');

      expect(zone.name).toBe('example.com.');
      expect(zone.kind).toBe('Master');

      const calls = getExecCalls();
      const addzoneCall = calls.find((c) => c.args.includes('addzone'));
      expect(addzoneCall).toBeDefined();
      expect(addzoneCall!.args).toContain('example.com.');
    });

    it('should return existing zone if found', async () => {
      mockExecSuccess('name: example.com.\nserial: 100\n');

      const provider = new RndcDnsProvider(config);
      const zone = await provider.createZone('example.com', 'Master');

      expect(zone.name).toBe('example.com.');
      // Should only have called zonestatus, not addzone
      const calls = getExecCalls();
      expect(calls.every((c) => !c.args.includes('addzone'))).toBe(true);
    });
  });

  describe('deleteZone', () => {
    it('should call rndc delzone', async () => {
      mockExecSuccess('');

      const provider = new RndcDnsProvider(config);
      await provider.deleteZone('example.com');

      const calls = getExecCalls();
      expect(calls[0].args).toContain('delzone');
      expect(calls[0].args).toContain('example.com.');
    });

    it('should throw on rndc error', async () => {
      mockExecError('not found');

      const provider = new RndcDnsProvider(config);
      await expect(provider.deleteZone('missing.com')).rejects.toThrow('not found');
    });
  });

  describe('listRecords', () => {
    it('should return empty array (rndc does not support record listing)', async () => {
      const provider = new RndcDnsProvider(config);
      const records = await provider.listRecords('example.com');

      expect(records).toEqual([]);
    });
  });

  describe('createRecord', () => {
    it('should call rndc addrecord', async () => {
      mockExecSuccess('');

      const provider = new RndcDnsProvider(config);
      const record = await provider.createRecord('example.com', {
        type: 'A', name: 'www', content: '1.2.3.4', ttl: 300,
      });

      expect(record.type).toBe('A');
      expect(record.content).toBe('1.2.3.4');
      expect(record.ttl).toBe(300);
      expect(record.id).toContain('www');

      const calls = getExecCalls();
      expect(calls[0].args).toContain('addrecord');
      expect(calls[0].args).toContain('example.com.');
      expect(calls[0].args).toContain('300');
      expect(calls[0].args).toContain('A');
      expect(calls[0].args).toContain('1.2.3.4');
    });

    it('should format MX records with priority', async () => {
      mockExecSuccess('');

      const provider = new RndcDnsProvider(config);
      const record = await provider.createRecord('example.com', {
        type: 'MX', name: 'mail', content: 'mail.example.com.', priority: 10,
      });

      expect(record.type).toBe('MX');
      const calls = getExecCalls();
      // The content passed to rndc should include priority
      expect(calls[0].args).toContain('10 mail.example.com.');
    });

    it('should throw on rndc error', async () => {
      mockExecError('addrecord failed');

      const provider = new RndcDnsProvider(config);
      await expect(provider.createRecord('example.com', {
        type: 'A', name: 'www', content: '1.2.3.4',
      })).rejects.toThrow('addrecord failed');
    });
  });

  describe('updateRecord', () => {
    it('should delete old record then create new one', async () => {
      mockExecSuccess('');

      const provider = new RndcDnsProvider(config);
      const record = await provider.updateRecord('example.com', 'www.example.com.|A|1.2.3.4', {
        content: '5.6.7.8',
      });

      expect(record.content).toBe('5.6.7.8');

      const calls = getExecCalls();
      const delCall = calls.find((c) => c.args.includes('delrecord'));
      const addCall = calls.find((c) => c.args.includes('addrecord'));
      expect(delCall).toBeDefined();
      expect(addCall).toBeDefined();
    });
  });

  describe('deleteRecord', () => {
    it('should call rndc delrecord with parsed id components', async () => {
      mockExecSuccess('');

      const provider = new RndcDnsProvider(config);
      await provider.deleteRecord('example.com', 'www.example.com.|A|1.2.3.4');

      const calls = getExecCalls();
      expect(calls[0].args).toContain('delrecord');
      expect(calls[0].args).toContain('example.com.');
      expect(calls[0].args).toContain('www.example.com.');
      expect(calls[0].args).toContain('A');
      expect(calls[0].args).toContain('1.2.3.4');
    });
  });
});
