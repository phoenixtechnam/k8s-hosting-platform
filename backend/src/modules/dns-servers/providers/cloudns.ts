import type { DnsProviderAdapter, DnsZone, DnsRecord, DnsRecordInput, ClouDnsConfig } from './types.js';

/**
 * ClouDNS provider using the ClouDNS HTTP API.
 * https://www.cloudns.net/wiki/article/56/
 */
export class ClouDnsProvider implements DnsProviderAdapter {
  readonly providerType = 'cloudns';
  private readonly baseUrl: string;
  private readonly authParams: Record<string, string>;

  constructor(private readonly config: ClouDnsConfig) {
    this.baseUrl = config.api_url ?? 'https://api.cloudns.net';
    this.authParams = config.sub_auth_id
      ? { 'sub-auth-id': config.sub_auth_id, 'auth-password': config.auth_password }
      : { 'auth-id': config.auth_id!, 'auth-password': config.auth_password };
  }

  private qs(extra: Record<string, string | number> = {}): string {
    const params = new URLSearchParams({ ...this.authParams });
    for (const [k, v] of Object.entries(extra)) {
      params.set(k, String(v));
    }
    return params.toString();
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, options);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ClouDNS API: ${res.status} — ${body}`);
    }
    const body = await res.json() as T & { status?: string; statusDescription?: string };
    // ClouDNS returns { status: 'Failed', statusDescription: '...' } on logical errors
    if (body && typeof body === 'object' && 'status' in body && body.status === 'Failed') {
      throw new Error(`ClouDNS API: ${body.statusDescription ?? 'Unknown error'}`);
    }
    return body;
  }

  async testConnection(): Promise<{ status: 'ok' | 'error'; message?: string; version?: string }> {
    try {
      const result = await this.request<{ status: string; statusDescription?: string }>(
        `/dns/login.json?${this.qs()}`,
      );
      if (result.status === 'Success') {
        return { status: 'ok', message: 'ClouDNS authentication valid', version: 'v1' };
      }
      return { status: 'error', message: result.statusDescription ?? 'Authentication failed' };
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : 'Connection failed' };
    }
  }

  async listZones(): Promise<DnsZone[]> {
    const data = await this.request<Record<string, ClouDnsZone>>(
      `/dns/list-zones.json?${this.qs({ page: 1, 'rows-per-page': 100 })}`,
    );
    // ClouDNS returns an object keyed by zone name, or an empty array when no zones exist
    if (Array.isArray(data)) return [];
    return Object.values(data).map((z) => ({
      name: z.name.endsWith('.') ? z.name : `${z.name}.`,
      kind: 'Native',
      serial: 0,
    }));
  }

  async getZone(name: string): Promise<DnsZone | null> {
    const clean = name.replace(/\.$/, '');
    try {
      const data = await this.request<{ name: string; type: string; zone: string } | { status: string }>(
        `/dns/get-zone-info.json?${this.qs({ 'domain-name': clean })}`,
      );
      if ('status' in data) return null;
      return { name: `${data.name}.`, kind: 'Native', serial: 0 };
    } catch {
      return null;
    }
  }

  async createZone(name: string, _kind: 'Native' | 'Master'): Promise<DnsZone> {
    const clean = name.replace(/\.$/, '');
    const existing = await this.getZone(clean);
    if (existing) return existing;

    await this.request<{ status: string }>(
      `/dns/register.json?${this.qs({ 'domain-name': clean, 'zone-type': 'master' })}`,
    );
    return { name: `${clean}.`, kind: 'Native', serial: 0 };
  }

  async deleteZone(name: string): Promise<void> {
    const clean = name.replace(/\.$/, '');
    await this.request<{ status: string }>(
      `/dns/delete.json?${this.qs({ 'domain-name': clean })}`,
    );
  }

  async listRecords(zone: string): Promise<DnsRecord[]> {
    const clean = zone.replace(/\.$/, '');
    const data = await this.request<Record<string, ClouDnsRecord>>(
      `/dns/records.json?${this.qs({ 'domain-name': clean })}`,
    );
    // ClouDNS returns an empty array when no records exist
    if (Array.isArray(data)) return [];
    return Object.entries(data).map(([id, r]) => ({
      id,
      type: r.type,
      name: r.host === '' ? `${clean}.` : `${r.host}.${clean}.`,
      content: r.record,
      ttl: Number(r.ttl),
      priority: r.priority ? Number(r.priority) : null,
    }));
  }

  async createRecord(zone: string, input: DnsRecordInput): Promise<DnsRecord> {
    const clean = zone.replace(/\.$/, '');
    const host = input.name
      .replace(/\.$/, '')
      .replace(new RegExp(`\\.?${clean.replace(/\./g, '\\.')}$`), '') || '';

    const params: Record<string, string | number> = {
      'domain-name': clean,
      'record-type': input.type,
      host,
      record: input.content,
      ttl: input.ttl ?? 3600,
    };
    if (input.priority !== undefined) params.priority = input.priority;

    const result = await this.request<{ data: { id: string | number } }>(
      `/dns/add-record.json?${this.qs(params)}`,
      { method: 'POST' },
    );

    return {
      id: String(result.data.id),
      type: input.type,
      name: host === '' ? `${clean}.` : `${host}.${clean}.`,
      content: input.content,
      ttl: input.ttl ?? 3600,
      priority: input.priority ?? null,
    };
  }

  async updateRecord(zone: string, recordId: string, input: Partial<DnsRecordInput>): Promise<DnsRecord> {
    const clean = zone.replace(/\.$/, '');
    const host = input.name
      ? input.name.replace(/\.$/, '').replace(new RegExp(`\\.?${clean.replace(/\./g, '\\.')}$`), '') || ''
      : undefined;

    const params: Record<string, string | number> = {
      'domain-name': clean,
      'record-id': recordId,
    };
    if (host !== undefined) params.host = host;
    if (input.content !== undefined) params.record = input.content;
    if (input.type !== undefined) params['record-type'] = input.type;
    if (input.ttl !== undefined) params.ttl = input.ttl;
    if (input.priority !== undefined) params.priority = input.priority;

    await this.request<{ status: string }>(
      `/dns/mod-record.json?${this.qs(params)}`,
      { method: 'POST' },
    );

    return {
      id: recordId,
      type: input.type ?? '',
      name: host !== undefined
        ? (host === '' ? `${clean}.` : `${host}.${clean}.`)
        : '',
      content: input.content ?? '',
      ttl: input.ttl ?? 3600,
      priority: input.priority ?? null,
    };
  }

  async deleteRecord(zone: string, recordId: string): Promise<void> {
    const clean = zone.replace(/\.$/, '');
    await this.request<{ status: string }>(
      `/dns/delete-record.json?${this.qs({ 'domain-name': clean, 'record-id': recordId })}`,
      { method: 'POST' },
    );
  }
}

interface ClouDnsZone { readonly name: string; readonly type: string; }
interface ClouDnsRecord { readonly type: string; readonly host: string; readonly record: string; readonly ttl: string; readonly priority?: string; }
