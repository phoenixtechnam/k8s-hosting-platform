import { execFile } from 'child_process';
import { promisify } from 'util';
import type { DnsProviderAdapter, DnsZone, DnsRecord, DnsRecordInput, RndcConfig } from './types.js';

const exec = promisify(execFile);

/**
 * BIND9 DNS provider via rndc (remote name daemon control).
 * Uses ONLY rndc commands — no nsupdate dependency.
 * Requires rndc binary on the system PATH and BIND 9.11+.
 */
export class RndcDnsProvider implements DnsProviderAdapter {
  readonly providerType = 'rndc';

  constructor(private readonly config: RndcConfig) {}

  private rndcArgs(): string[] {
    return [
      '-s', this.config.server_host,
      '-p', String(this.config.rndc_port ?? 953),
      '-y', `${this.config.rndc_key_algorithm}:${this.config.rndc_key_name}:${this.config.rndc_key_secret}`,
    ];
  }

  private async rndc(...args: string[]): Promise<string> {
    const { stdout } = await exec('rndc', [...this.rndcArgs(), ...args]);
    return stdout;
  }

  async testConnection(): Promise<{ status: 'ok' | 'error'; message?: string; version?: string }> {
    try {
      const stdout = await this.rndc('status');
      const versionMatch = stdout.match(/version:\s*(.+)/i);
      return { status: 'ok', message: 'BIND9 connected via rndc', version: versionMatch?.[1]?.trim() };
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : 'rndc connection failed' };
    }
  }

  async listZones(): Promise<DnsZone[]> {
    try {
      const stdout = await this.rndc('zonestatus');
      const zones: DnsZone[] = [];
      const matches = stdout.matchAll(/name:\s*(\S+)/g);
      for (const match of matches) {
        zones.push({ name: match[1], kind: 'Master', serial: 0 });
      }
      return zones;
    } catch {
      return [];
    }
  }

  async getZone(name: string): Promise<DnsZone | null> {
    const zones = await this.listZones();
    const normalized = name.endsWith('.') ? name : `${name}.`;
    return zones.find((z) => z.name === normalized) ?? null;
  }

  async createZone(name: string, _kind: 'Native' | 'Master'): Promise<DnsZone> {
    const existing = await this.getZone(name);
    if (existing) return existing;

    const normalized = name.endsWith('.') ? name : `${name}.`;
    const zoneConfig = `{ type master; file "${normalized}zone"; allow-update { key "${this.config.rndc_key_name}"; }; };`;
    await this.rndc('addzone', normalized, zoneConfig);
    return { name: normalized, kind: 'Master', serial: 1 };
  }

  async deleteZone(name: string): Promise<void> {
    const normalized = name.endsWith('.') ? name : `${name}.`;
    await this.rndc('delzone', normalized);
  }

  async listRecords(_zone: string): Promise<DnsRecord[]> {
    // BIND does not expose record listing via rndc.
    // Records are tracked in the platform's local dns_records table.
    return [];
  }

  async createRecord(zone: string, input: DnsRecordInput): Promise<DnsRecord> {
    const normalized = zone.endsWith('.') ? zone : `${zone}.`;
    const name = input.name.endsWith('.') ? input.name : `${input.name}.${normalized}`;
    const content = input.type === 'MX' && input.priority ? `${input.priority} ${input.content}` : input.content;

    // rndc addrecord zone name ttl type content (BIND 9.11+)
    await this.rndc('addrecord', normalized, name, String(input.ttl ?? 3600), input.type, content);

    return {
      id: `${name}|${input.type}|${input.content}`,
      type: input.type, name, content: input.content,
      ttl: input.ttl ?? 3600, priority: input.priority ?? null,
    };
  }

  async updateRecord(zone: string, recordId: string, input: Partial<DnsRecordInput>): Promise<DnsRecord> {
    // rndc doesn't support atomic update — delete old + add new
    await this.deleteRecord(zone, recordId);
    const [name, type, oldContent] = recordId.split('|');
    return this.createRecord(zone, {
      type: input.type ?? type,
      name: input.name ?? name,
      content: input.content ?? oldContent,
      ttl: input.ttl ?? 3600,
      priority: input.priority,
    });
  }

  async deleteRecord(zone: string, recordId: string): Promise<void> {
    const normalized = zone.endsWith('.') ? zone : `${zone}.`;
    const [name, type, content] = recordId.split('|');
    // rndc delrecord zone name type content (BIND 9.11+)
    await this.rndc('delrecord', normalized, name, type, content);
  }
}
