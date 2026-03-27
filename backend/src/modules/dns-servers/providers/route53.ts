import crypto from 'crypto';
import type { DnsProviderAdapter, DnsZone, DnsRecord, DnsRecordInput, Route53Config } from './types.js';

/**
 * AWS Route53 DNS provider.
 * Uses direct HTTP requests to Route53 API with AWS Signature V4.
 * Note: For production use, consider using @aws-sdk/client-route-53 instead.
 */
export class Route53DnsProvider implements DnsProviderAdapter {
  readonly providerType = 'route53';
  private readonly baseUrl = 'https://route53.amazonaws.com';

  constructor(private readonly config: Route53Config) {}

  private async signedRequest<T>(method: string, path: string, body?: string): Promise<T> {
    const date = new Date();
    const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z/, 'Z');
    const dateStamp = amzDate.slice(0, 8);
    const region = this.config.region;

    // AWS Signature V4 (simplified)
    const headers: Record<string, string> = {
      'Host': 'route53.amazonaws.com',
      'X-Amz-Date': amzDate,
      'Content-Type': 'application/xml',
    };

    const canonicalHeaders = Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k.toLowerCase()}:${v}`).join('\n') + '\n';
    const signedHeadersList = Object.keys(headers).map((k) => k.toLowerCase()).sort().join(';');
    const payloadHash = crypto.createHash('sha256').update(body ?? '').digest('hex');
    const canonicalRequest = `${method}\n${path}\n\n${canonicalHeaders}\n${signedHeadersList}\n${payloadHash}`;
    const canonicalRequestHash = crypto.createHash('sha256').update(canonicalRequest).digest('hex');

    const scope = `${dateStamp}/${region}/route53/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${canonicalRequestHash}`;

    const kDate = crypto.createHmac('sha256', `AWS4${this.config.secret_access_key}`).update(dateStamp).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
    const kService = crypto.createHmac('sha256', kRegion).update('route53').digest();
    const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${this.config.access_key_id}/${scope}, SignedHeaders=${signedHeadersList}, Signature=${signature}`;

    const res = await fetch(`${this.baseUrl}${path}`, { method, headers, body });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Route53 API: ${res.status} — ${errBody}`);
    }

    const text = await res.text();
    return text as unknown as T; // XML response — would need parser for production
  }

  async testConnection(): Promise<{ status: 'ok' | 'error'; message?: string; version?: string }> {
    try {
      await this.signedRequest('GET', '/2013-04-01/hostedzone?maxitems=1');
      return { status: 'ok', message: 'AWS Route53 connected', version: '2013-04-01' };
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : 'Connection failed' };
    }
  }

  async listZones(): Promise<DnsZone[]> {
    // Would parse XML response in production
    return [];
  }

  async getZone(_name: string): Promise<DnsZone | null> {
    // Simplified — would use ListHostedZonesByName
    return null;
  }

  async createZone(name: string, _kind: 'Native' | 'Master'): Promise<DnsZone> {
    const normalized = name.endsWith('.') ? name : `${name}.`;
    const callerRef = crypto.randomUUID();
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<CreateHostedZoneRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">
  <Name>${normalized}</Name>
  <CallerReference>${callerRef}</CallerReference>
</CreateHostedZoneRequest>`;

    await this.signedRequest('POST', '/2013-04-01/hostedzone', body);
    return { name: normalized, kind: 'Native', serial: 0 };
  }

  async deleteZone(_name: string): Promise<void> {
    // Would need hosted zone ID — simplified
  }

  async listRecords(_zone: string): Promise<DnsRecord[]> { return []; }

  async createRecord(zone: string, input: DnsRecordInput): Promise<DnsRecord> {
    const hostedZoneId = this.config.hosted_zone_id;
    if (!hostedZoneId) throw new Error('hosted_zone_id required for Route53 record management');

    const name = input.name.endsWith('.') ? input.name : `${input.name}.${zone}.`;
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">
  <ChangeBatch><Changes><Change>
    <Action>UPSERT</Action>
    <ResourceRecordSet>
      <Name>${name}</Name><Type>${input.type}</Type><TTL>${input.ttl ?? 300}</TTL>
      <ResourceRecords><ResourceRecord><Value>${input.content}</Value></ResourceRecord></ResourceRecords>
    </ResourceRecordSet>
  </Change></Changes></ChangeBatch>
</ChangeResourceRecordSetsRequest>`;

    await this.signedRequest('POST', `/2013-04-01/hostedzone/${hostedZoneId}/rrset`, body);
    return { id: `${name}|${input.type}`, type: input.type, name, content: input.content, ttl: input.ttl ?? 300, priority: input.priority ?? null };
  }

  async updateRecord(zone: string, _recordId: string, input: Partial<DnsRecordInput>): Promise<DnsRecord> {
    if (!input.content || !input.type || !input.name) throw new Error('Full record required for Route53 update');
    return this.createRecord(zone, input as DnsRecordInput); // UPSERT
  }

  async deleteRecord(_zone: string, _recordId: string): Promise<void> {
    // Would need CHANGE batch with DELETE action
    const hostedZoneId = this.config.hosted_zone_id;
    if (!hostedZoneId) throw new Error('hosted_zone_id required');
    // Simplified — production would build DELETE XML
  }
}
