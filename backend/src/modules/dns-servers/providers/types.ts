// ─── DNS Provider Adapter Interface ───────────────────────────────────────────

export interface DnsZone {
  readonly name: string;
  readonly kind: string; // Native, Master, Slave
  readonly serial: number;
  readonly records_count?: number;
}

export interface DnsRecord {
  readonly id: string;
  readonly type: string; // A, AAAA, CNAME, MX, TXT, SRV, NS
  readonly name: string;
  readonly content: string;
  readonly ttl: number;
  readonly priority?: number | null;
}

export interface DnsRecordInput {
  readonly type: string;
  readonly name: string;
  readonly content: string;
  readonly ttl?: number;
  readonly priority?: number;
}

export interface DnsProviderAdapter {
  readonly providerType: string;

  testConnection(): Promise<{ status: 'ok' | 'error'; message?: string; version?: string }>;

  listZones(): Promise<DnsZone[]>;
  getZone(name: string): Promise<DnsZone | null>;
  createZone(name: string, kind: 'Native' | 'Master'): Promise<DnsZone>;
  deleteZone(name: string): Promise<void>;

  listRecords(zone: string): Promise<DnsRecord[]>;
  createRecord(zone: string, record: DnsRecordInput): Promise<DnsRecord>;
  updateRecord(zone: string, recordId: string, record: Partial<DnsRecordInput>): Promise<DnsRecord>;
  deleteRecord(zone: string, recordId: string): Promise<void>;
}

// ─── Provider Config Types ───────────────────────────────────────────────────

export interface PowerDnsConfig {
  readonly api_url: string;
  readonly api_key: string;
  readonly server_id: string;
  readonly api_version: 'v4' | 'v5';
}

export interface RndcConfig {
  readonly server_host: string;
  readonly rndc_port: number;
  readonly rndc_key_name: string;
  readonly rndc_key_algorithm: string;
  readonly rndc_key_secret: string;
}

export interface CloudflareConfig {
  readonly api_token: string;
}

export interface Route53Config {
  readonly access_key_id: string;
  readonly secret_access_key: string;
  readonly region: string;
  readonly hosted_zone_id?: string;
}

export interface HetznerDnsConfig {
  readonly api_token: string;
}

export interface MockConfig {
  readonly latency_ms?: number;
}
