export type { DnsProviderAdapter, DnsZone, DnsRecord, DnsRecordInput, PowerDnsConfig, RndcConfig, MockConfig } from './types.js';
export { MockDnsProvider } from './mock.js';
export { PowerDnsProvider } from './powerdns.js';

import type { DnsProviderAdapter } from './types.js';
import { MockDnsProvider } from './mock.js';
import { PowerDnsProvider } from './powerdns.js';

export function createProvider(providerType: string, config: Record<string, unknown>): DnsProviderAdapter {
  switch (providerType) {
    case 'mock':
      return new MockDnsProvider(config as any);
    case 'powerdns':
      return new PowerDnsProvider(config as any);
    case 'rndc':
      throw new Error('RNDC provider not yet implemented — planned for Phase 2');
    case 'cloudflare':
      throw new Error('Cloudflare provider not yet implemented — planned for Phase 2');
    case 'route53':
      throw new Error('Route53 provider not yet implemented — planned for Phase 2');
    case 'hetzner':
      throw new Error('Hetzner DNS provider not yet implemented — planned for Phase 2');
    default:
      throw new Error(`Unknown DNS provider type: ${providerType}`);
  }
}
