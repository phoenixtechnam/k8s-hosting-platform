import type { DnsProviderAdapter, DnsZone, DnsRecord, DnsRecordInput, PowerDnsConfig } from './types.js';

/**
 * PowerDNS Authoritative Server provider (API v4 / v5).
 * Uses the PowerDNS REST API for zone and record management.
 */
export class PowerDnsProvider implements DnsProviderAdapter {
  readonly providerType = 'powerdns';
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(private readonly config: PowerDnsConfig) {
    const apiBase = config.api_url.replace(/\/$/, '');
    this.baseUrl = `${apiBase}/api/v1/servers/${config.server_id}`;
    this.headers = {
      'X-API-Key': config.api_key,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: { ...this.headers, ...options.headers },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`PowerDNS API error: ${res.status} ${res.statusText} — ${body}`);
    }

    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  async testConnection(): Promise<{ status: 'ok' | 'error'; message?: string; version?: string }> {
    try {
      const info = await this.request<{ version: string; daemon_type: string }>('');
      return { status: 'ok', message: `PowerDNS ${info.daemon_type}`, version: info.version };
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : 'Connection failed' };
    }
  }

  async listZones(): Promise<DnsZone[]> {
    const zones = await this.request<PdnsZone[]>('/zones');
    return zones.map(toZone);
  }

  async getZone(name: string): Promise<DnsZone | null> {
    const normalized = name.endsWith('.') ? name : `${name}.`;
    try {
      const zone = await this.request<PdnsZone>(`/zones/${normalized}`);
      return toZone(zone);
    } catch {
      return null;
    }
  }

  async createZone(name: string, kind: 'Native' | 'Master'): Promise<DnsZone> {
    const normalized = name.endsWith('.') ? name : `${name}.`;

    // Check if zone already exists
    const existing = await this.getZone(normalized);
    if (existing) return existing;

    const zone = await this.request<PdnsZone>('/zones', {
      method: 'POST',
      body: JSON.stringify({
        name: normalized,
        kind,
        nameservers: [`ns1.${normalized}`, `ns2.${normalized}`],
      }),
    });
    return toZone(zone);
  }

  async deleteZone(name: string): Promise<void> {
    const normalized = name.endsWith('.') ? name : `${name}.`;
    await this.request<void>(`/zones/${normalized}`, { method: 'DELETE' });
  }

  async listRecords(zone: string): Promise<DnsRecord[]> {
    const normalized = zone.endsWith('.') ? zone : `${zone}.`;
    const zoneData = await this.request<PdnsZoneDetail>(`/zones/${normalized}`);

    const records: DnsRecord[] = [];
    for (const rrset of zoneData.rrsets ?? []) {
      for (const rec of rrset.records ?? []) {
        records.push({
          id: `${rrset.name}|${rrset.type}|${rec.content}`,
          type: rrset.type,
          name: rrset.name,
          content: rec.content,
          ttl: rrset.ttl,
          priority: parsePriority(rrset.type, rec.content),
        });
      }
    }
    return records;
  }

  async createRecord(zone: string, input: DnsRecordInput): Promise<DnsRecord> {
    const normalized = zone.endsWith('.') ? zone : `${zone}.`;
    const recordName = input.name.endsWith('.') ? input.name : `${input.name}.${normalized}`;

    // PowerDNS uses PATCH with RRSets for record management
    await this.request<void>(`/zones/${normalized}`, {
      method: 'PATCH',
      body: JSON.stringify({
        rrsets: [{
          name: recordName,
          type: input.type,
          ttl: input.ttl ?? 3600,
          changetype: 'REPLACE',
          records: [{ content: formatContent(input), disabled: false }],
        }],
      }),
    });

    return {
      id: `${recordName}|${input.type}|${formatContent(input)}`,
      type: input.type,
      name: recordName,
      content: formatContent(input),
      ttl: input.ttl ?? 3600,
      priority: input.priority ?? null,
    };
  }

  async updateRecord(zone: string, recordId: string, input: Partial<DnsRecordInput>): Promise<DnsRecord> {
    const [name, type] = recordId.split('|');
    const normalized = zone.endsWith('.') ? zone : `${zone}.`;

    const content = input.content ?? recordId.split('|')[2];

    await this.request<void>(`/zones/${normalized}`, {
      method: 'PATCH',
      body: JSON.stringify({
        rrsets: [{
          name,
          type: input.type ?? type,
          ttl: input.ttl ?? 3600,
          changetype: 'REPLACE',
          records: [{ content, disabled: false }],
        }],
      }),
    });

    return {
      id: `${name}|${input.type ?? type}|${content}`,
      type: input.type ?? type,
      name,
      content,
      ttl: input.ttl ?? 3600,
      priority: input.priority ?? null,
    };
  }

  async deleteRecord(zone: string, recordId: string): Promise<void> {
    const [name, type] = recordId.split('|');
    const normalized = zone.endsWith('.') ? zone : `${zone}.`;

    await this.request<void>(`/zones/${normalized}`, {
      method: 'PATCH',
      body: JSON.stringify({
        rrsets: [{
          name,
          type,
          changetype: 'DELETE',
          records: [],
        }],
      }),
    });
  }
}

// ─── PowerDNS API Types ──────────────────────────────────────────────────────

interface PdnsZone {
  readonly name: string;
  readonly kind: string;
  readonly serial: number;
  readonly rrsets?: PdnsRRSet[];
}

interface PdnsZoneDetail extends PdnsZone {
  readonly rrsets: PdnsRRSet[];
}

interface PdnsRRSet {
  readonly name: string;
  readonly type: string;
  readonly ttl: number;
  readonly records: readonly { content: string; disabled: boolean }[];
}

function toZone(z: PdnsZone): DnsZone {
  return { name: z.name, kind: z.kind, serial: z.serial };
}

function formatContent(input: DnsRecordInput): string {
  if (input.type === 'MX' && input.priority != null) {
    return `${input.priority} ${input.content}`;
  }
  return input.content;
}

function parsePriority(type: string, content: string): number | null {
  if (type === 'MX') {
    const parts = content.split(/\s+/);
    return parts.length >= 2 ? parseInt(parts[0], 10) : null;
  }
  return null;
}
