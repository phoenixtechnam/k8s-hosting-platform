import type { DnsProviderAdapter, DnsZone, DnsRecord, DnsRecordInput, HetznerDnsConfig } from './types.js';

/**
 * Hetzner DNS provider using the Hetzner DNS API.
 * https://dns.hetzner.com/api-docs
 */
export class HetznerDnsProvider implements DnsProviderAdapter {
  readonly providerType = 'hetzner';
  private readonly baseUrl = 'https://dns.hetzner.com/api/v1';
  private readonly headers: Record<string, string>;

  constructor(private readonly config: HetznerDnsConfig) {
    this.headers = {
      'Auth-API-Token': config.api_token,
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { ...options, headers: { ...this.headers, ...options.headers } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Hetzner DNS API: ${res.status} — ${body}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  async testConnection(): Promise<{ status: 'ok' | 'error'; message?: string; version?: string }> {
    try {
      await this.request<{ zones: HtzZone[] }>('/zones?per_page=1');
      return { status: 'ok', message: 'Hetzner DNS connected', version: 'v1' };
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : 'Connection failed' };
    }
  }

  async listZones(): Promise<DnsZone[]> {
    const resp = await this.request<{ zones: HtzZone[] }>('/zones?per_page=100');
    return resp.zones.map((z) => ({ name: z.name.endsWith('.') ? z.name : `${z.name}.`, kind: 'Native', serial: 0, records_count: z.records_count }));
  }

  async getZone(name: string): Promise<DnsZone | null> {
    const clean = name.replace(/\.$/, '');
    const resp = await this.request<{ zones: HtzZone[] }>(`/zones?name=${clean}`);
    if (resp.zones.length === 0) return null;
    const z = resp.zones[0];
    return { name: `${z.name}.`, kind: 'Native', serial: 0, records_count: z.records_count };
  }

  async createZone(name: string, _kind: 'Native' | 'Master'): Promise<DnsZone> {
    const clean = name.replace(/\.$/, '');
    const existing = await this.getZone(clean);
    if (existing) return existing;

    const resp = await this.request<{ zone: HtzZone }>('/zones', {
      method: 'POST',
      body: JSON.stringify({ name: clean, ttl: 3600 }),
    });
    return { name: `${resp.zone.name}.`, kind: 'Native', serial: 0 };
  }

  async deleteZone(name: string): Promise<void> {
    const clean = name.replace(/\.$/, '');
    const zones = await this.request<{ zones: HtzZone[] }>(`/zones?name=${clean}`);
    if (zones.zones.length > 0) {
      await this.request<void>(`/zones/${zones.zones[0].id}`, { method: 'DELETE' });
    }
  }

  private async getZoneId(zone: string): Promise<string> {
    const clean = zone.replace(/\.$/, '');
    const resp = await this.request<{ zones: HtzZone[] }>(`/zones?name=${clean}`);
    if (resp.zones.length === 0) throw new Error(`Zone '${zone}' not found on Hetzner DNS`);
    return resp.zones[0].id;
  }

  async listRecords(zone: string): Promise<DnsRecord[]> {
    const zoneId = await this.getZoneId(zone);
    const resp = await this.request<{ records: HtzRecord[] }>(`/records?zone_id=${zoneId}&per_page=100`);
    return resp.records.map((r) => ({
      id: r.id, type: r.type, name: `${r.name}.${zone.replace(/\.$/, '')}.`,
      content: r.value, ttl: r.ttl ?? 3600, priority: null,
    }));
  }

  async createRecord(zone: string, input: DnsRecordInput): Promise<DnsRecord> {
    const zoneId = await this.getZoneId(zone);
    const cleanName = input.name.replace(/\.$/, '').replace(new RegExp(`\\.?${zone.replace(/\.$/, '')}$`), '') || '@';

    const resp = await this.request<{ record: HtzRecord }>('/records', {
      method: 'POST',
      body: JSON.stringify({ zone_id: zoneId, type: input.type, name: cleanName, value: input.content, ttl: input.ttl ?? 3600 }),
    });

    return { id: resp.record.id, type: resp.record.type, name: input.name, content: resp.record.value, ttl: resp.record.ttl ?? 3600, priority: null };
  }

  async updateRecord(zone: string, recordId: string, input: Partial<DnsRecordInput>): Promise<DnsRecord> {
    const zoneId = await this.getZoneId(zone);

    const resp = await this.request<{ record: HtzRecord }>(`/records/${recordId}`, {
      method: 'PUT',
      body: JSON.stringify({
        zone_id: zoneId,
        type: input.type, name: input.name?.replace(/\.$/, '') ?? '@',
        value: input.content, ttl: input.ttl ?? 3600,
      }),
    });

    return { id: resp.record.id, type: resp.record.type, name: input.name ?? '', content: resp.record.value, ttl: resp.record.ttl ?? 3600, priority: null };
  }

  async deleteRecord(_zone: string, recordId: string): Promise<void> {
    await this.request<void>(`/records/${recordId}`, { method: 'DELETE' });
  }
}

interface HtzZone { readonly id: string; readonly name: string; readonly records_count?: number; }
interface HtzRecord { readonly id: string; readonly type: string; readonly name: string; readonly value: string; readonly ttl?: number; }
