import type { DnsProviderAdapter, DnsZone, DnsRecord, DnsRecordInput, CloudflareConfig } from './types.js';

/**
 * Cloudflare DNS provider using the Cloudflare API v4.
 * https://api.cloudflare.com/#dns-records-for-a-zone-properties
 */
export class CloudflareDnsProvider implements DnsProviderAdapter {
  readonly providerType = 'cloudflare';
  private readonly baseUrl = 'https://api.cloudflare.com/client/v4';
  private readonly headers: Record<string, string>;

  constructor(private readonly config: CloudflareConfig) {
    this.headers = {
      'Authorization': `Bearer ${config.api_token}`,
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { ...options, headers: { ...this.headers, ...options.headers } });
    const body = await res.json() as { success: boolean; result: T; errors: { message: string }[] };
    if (!body.success) throw new Error(`Cloudflare API: ${body.errors?.[0]?.message ?? res.statusText}`);
    return body.result;
  }

  async testConnection(): Promise<{ status: 'ok' | 'error'; message?: string; version?: string }> {
    try {
      await this.request<{ id: string }>('/user/tokens/verify');
      return { status: 'ok', message: 'Cloudflare API token valid', version: 'v4' };
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : 'Connection failed' };
    }
  }

  async listZones(): Promise<DnsZone[]> {
    const zones = await this.request<CfZone[]>('/zones?per_page=100');
    return zones.map((z) => ({ name: z.name.endsWith('.') ? z.name : `${z.name}.`, kind: 'Native', serial: 0 }));
  }

  async getZone(name: string): Promise<DnsZone | null> {
    const clean = name.replace(/\.$/, '');
    const zones = await this.request<CfZone[]>(`/zones?name=${clean}`);
    if (zones.length === 0) return null;
    return { name: `${zones[0].name}.`, kind: 'Native', serial: 0 };
  }

  async createZone(name: string, _kind: 'Native' | 'Master'): Promise<DnsZone> {
    const clean = name.replace(/\.$/, '');
    const existing = await this.getZone(clean);
    if (existing) return existing;

    const zone = await this.request<CfZone>('/zones', {
      method: 'POST',
      body: JSON.stringify({ name: clean, jump_start: false }),
    });
    return { name: `${zone.name}.`, kind: 'Native', serial: 0 };
  }

  async deleteZone(name: string): Promise<void> {
    const clean = name.replace(/\.$/, '');
    const zones = await this.request<CfZone[]>(`/zones?name=${clean}`);
    if (zones.length > 0) {
      await this.request<void>(`/zones/${zones[0].id}`, { method: 'DELETE' });
    }
  }

  private async getZoneId(zone: string): Promise<string> {
    const clean = zone.replace(/\.$/, '');
    const zones = await this.request<CfZone[]>(`/zones?name=${clean}`);
    if (zones.length === 0) throw new Error(`Zone '${zone}' not found on Cloudflare`);
    return zones[0].id;
  }

  async listRecords(zone: string): Promise<DnsRecord[]> {
    const zoneId = await this.getZoneId(zone);
    const records = await this.request<CfRecord[]>(`/zones/${zoneId}/dns_records?per_page=100`);
    return records.map((r) => ({
      id: r.id, type: r.type, name: `${r.name}.`, content: r.content,
      ttl: r.ttl, priority: r.priority ?? null,
    }));
  }

  async createRecord(zone: string, input: DnsRecordInput): Promise<DnsRecord> {
    const zoneId = await this.getZoneId(zone);
    const cleanName = input.name.replace(/\.$/, '');

    const record = await this.request<CfRecord>(`/zones/${zoneId}/dns_records`, {
      method: 'POST',
      body: JSON.stringify({
        type: input.type, name: cleanName, content: input.content,
        ttl: input.ttl ?? 1, priority: input.priority,
      }),
    });

    return { id: record.id, type: record.type, name: `${record.name}.`, content: record.content, ttl: record.ttl, priority: record.priority ?? null };
  }

  async updateRecord(zone: string, recordId: string, input: Partial<DnsRecordInput>): Promise<DnsRecord> {
    const zoneId = await this.getZoneId(zone);
    // Fetch existing to merge
    const existing = await this.request<CfRecord>(`/zones/${zoneId}/dns_records/${recordId}`);

    const record = await this.request<CfRecord>(`/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        type: input.type ?? existing.type, name: input.name?.replace(/\.$/, '') ?? existing.name,
        content: input.content ?? existing.content, ttl: input.ttl ?? existing.ttl,
        priority: input.priority ?? existing.priority,
      }),
    });

    return { id: record.id, type: record.type, name: `${record.name}.`, content: record.content, ttl: record.ttl, priority: record.priority ?? null };
  }

  async deleteRecord(zone: string, recordId: string): Promise<void> {
    const zoneId = await this.getZoneId(zone);
    await this.request<void>(`/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' });
  }
}

interface CfZone { readonly id: string; readonly name: string; }
interface CfRecord { readonly id: string; readonly type: string; readonly name: string; readonly content: string; readonly ttl: number; readonly priority?: number; }
