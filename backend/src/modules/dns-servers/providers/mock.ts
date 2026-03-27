import type { DnsProviderAdapter, DnsZone, DnsRecord, DnsRecordInput, MockConfig } from './types.js';

/**
 * In-memory Mock DNS provider for testing and staging.
 * No external dependencies — stores everything in memory.
 */
export class MockDnsProvider implements DnsProviderAdapter {
  readonly providerType = 'mock';
  private readonly zones = new Map<string, { zone: DnsZone; records: DnsRecord[] }>();
  private nextRecordId = 1;

  constructor(private readonly config: MockConfig = {}) {}

  async testConnection(): Promise<{ status: 'ok'; message: string; version: string }> {
    return { status: 'ok', message: 'Mock DNS provider — in-memory storage', version: 'mock-1.0' };
  }

  async listZones(): Promise<DnsZone[]> {
    return Array.from(this.zones.values()).map((z) => ({
      ...z.zone,
      records_count: z.records.length,
    }));
  }

  async getZone(name: string): Promise<DnsZone | null> {
    const normalized = name.endsWith('.') ? name : `${name}.`;
    const entry = this.zones.get(normalized);
    return entry ? { ...entry.zone, records_count: entry.records.length } : null;
  }

  async createZone(name: string, kind: 'Native' | 'Master'): Promise<DnsZone> {
    const normalized = name.endsWith('.') ? name : `${name}.`;
    if (this.zones.has(normalized)) {
      return this.zones.get(normalized)!.zone;
    }
    const zone: DnsZone = { name: normalized, kind, serial: Date.now() };
    this.zones.set(normalized, { zone, records: [] });
    return zone;
  }

  async deleteZone(name: string): Promise<void> {
    const normalized = name.endsWith('.') ? name : `${name}.`;
    this.zones.delete(normalized);
  }

  async listRecords(zone: string): Promise<DnsRecord[]> {
    const normalized = zone.endsWith('.') ? zone : `${zone}.`;
    return this.zones.get(normalized)?.records ?? [];
  }

  async createRecord(zone: string, input: DnsRecordInput): Promise<DnsRecord> {
    const normalized = zone.endsWith('.') ? zone : `${zone}.`;
    const entry = this.zones.get(normalized);
    if (!entry) throw new Error(`Zone '${zone}' not found`);

    const record: DnsRecord = {
      id: `mock-${this.nextRecordId++}`,
      type: input.type,
      name: input.name,
      content: input.content,
      ttl: input.ttl ?? 3600,
      priority: input.priority ?? null,
    };
    entry.records.push(record);
    return record;
  }

  async updateRecord(zone: string, recordId: string, input: Partial<DnsRecordInput>): Promise<DnsRecord> {
    const normalized = zone.endsWith('.') ? zone : `${zone}.`;
    const entry = this.zones.get(normalized);
    if (!entry) throw new Error(`Zone '${zone}' not found`);

    const idx = entry.records.findIndex((r) => r.id === recordId);
    if (idx === -1) throw new Error(`Record '${recordId}' not found`);

    const existing = entry.records[idx];
    const updated: DnsRecord = {
      ...existing,
      type: input.type ?? existing.type,
      name: input.name ?? existing.name,
      content: input.content ?? existing.content,
      ttl: input.ttl ?? existing.ttl,
      priority: input.priority ?? existing.priority,
    };
    entry.records[idx] = updated;
    return updated;
  }

  async deleteRecord(zone: string, recordId: string): Promise<void> {
    const normalized = zone.endsWith('.') ? zone : `${zone}.`;
    const entry = this.zones.get(normalized);
    if (!entry) throw new Error(`Zone '${zone}' not found`);

    const idx = entry.records.findIndex((r) => r.id === recordId);
    if (idx === -1) throw new Error(`Record '${recordId}' not found`);
    entry.records.splice(idx, 1);
  }
}
