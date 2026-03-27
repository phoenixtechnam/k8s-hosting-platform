import { execFile } from 'child_process';
import { promisify } from 'util';
import type { DnsProviderAdapter, DnsZone, DnsRecord, DnsRecordInput, RndcConfig } from './types.js';

const exec = promisify(execFile);

/**
 * BIND9 DNS provider via rndc (remote name daemon control).
 * Uses `rndc` for zone management and `nsupdate` for record CRUD.
 * Requires rndc and nsupdate binaries available on the system PATH.
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

  async testConnection(): Promise<{ status: 'ok' | 'error'; message?: string; version?: string }> {
    try {
      const { stdout } = await exec('rndc', [...this.rndcArgs(), 'status']);
      const versionMatch = stdout.match(/version:\s*(.+)/i);
      return { status: 'ok', message: 'BIND9 connected via rndc', version: versionMatch?.[1]?.trim() };
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : 'rndc connection failed' };
    }
  }

  async listZones(): Promise<DnsZone[]> {
    try {
      const { stdout } = await exec('rndc', [...this.rndcArgs(), 'zonestatus']);
      // Parse rndc zonestatus output — simplified
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

  async createZone(name: string, kind: 'Native' | 'Master'): Promise<DnsZone> {
    const existing = await this.getZone(name);
    if (existing) return existing;

    const normalized = name.endsWith('.') ? name : `${name}.`;
    // rndc addzone requires a zone configuration string
    await exec('rndc', [...this.rndcArgs(), 'addzone', normalized, `{ type master; file "${normalized}zone"; allow-update { key "${this.config.rndc_key_name}"; }; };`]);
    return { name: normalized, kind, serial: 1 };
  }

  async deleteZone(name: string): Promise<void> {
    const normalized = name.endsWith('.') ? name : `${name}.`;
    await exec('rndc', [...this.rndcArgs(), 'delzone', normalized]);
  }

  async listRecords(zone: string): Promise<DnsRecord[]> {
    // BIND doesn't have a direct "list records" API via rndc
    // Would need to use `dig axfr` or parse zone file
    // For now, return empty — records are managed via nsupdate
    return [];
  }

  private async nsupdate(commands: string[]): Promise<void> {
    const input = [
      `server ${this.config.server_host}`,
      `key ${this.config.rndc_key_algorithm}:${this.config.rndc_key_name} ${this.config.rndc_key_secret}`,
      ...commands,
      'send',
      'quit',
    ].join('\n');

    await exec('nsupdate', [], { input } as any);
  }

  async createRecord(zone: string, input: DnsRecordInput): Promise<DnsRecord> {
    const name = input.name.endsWith('.') ? input.name : `${input.name}.${zone}.`;
    const content = input.type === 'MX' && input.priority ? `${input.priority} ${input.content}` : input.content;

    await this.nsupdate([
      `zone ${zone}`,
      `update add ${name} ${input.ttl ?? 3600} ${input.type} ${content}`,
    ]);

    return {
      id: `${name}|${input.type}|${input.content}`,
      type: input.type, name, content: input.content,
      ttl: input.ttl ?? 3600, priority: input.priority ?? null,
    };
  }

  async updateRecord(zone: string, recordId: string, input: Partial<DnsRecordInput>): Promise<DnsRecord> {
    const [name, type, oldContent] = recordId.split('|');
    // Delete old, add new
    await this.nsupdate([
      `zone ${zone}`,
      `update delete ${name} ${type}`,
      `update add ${name} ${input.ttl ?? 3600} ${input.type ?? type} ${input.content ?? oldContent}`,
    ]);

    return {
      id: `${name}|${input.type ?? type}|${input.content ?? oldContent}`,
      type: input.type ?? type, name, content: input.content ?? oldContent,
      ttl: input.ttl ?? 3600, priority: input.priority ?? null,
    };
  }

  async deleteRecord(zone: string, recordId: string): Promise<void> {
    const [name, type] = recordId.split('|');
    await this.nsupdate([
      `zone ${zone}`,
      `update delete ${name} ${type}`,
    ]);
  }
}
