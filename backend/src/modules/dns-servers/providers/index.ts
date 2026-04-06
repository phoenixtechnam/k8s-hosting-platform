export type { DnsProviderAdapter, DnsZone, DnsRecord, DnsRecordInput, PowerDnsConfig, RndcConfig, CloudflareConfig, Route53Config, HetznerDnsConfig, MockConfig } from './types.js';
export { MockDnsProvider } from './mock.js';
export { PowerDnsProvider } from './powerdns.js';
export { RndcDnsProvider } from './rndc.js';
export { CloudflareDnsProvider } from './cloudflare.js';
export { Route53DnsProvider } from './route53.js';
export { HetznerDnsProvider } from './hetzner.js';

import type { DnsProviderAdapter, MockConfig, PowerDnsConfig, RndcConfig, CloudflareConfig, Route53Config, HetznerDnsConfig } from './types.js';
import { MockDnsProvider } from './mock.js';
import { PowerDnsProvider } from './powerdns.js';
import { RndcDnsProvider } from './rndc.js';
import { CloudflareDnsProvider } from './cloudflare.js';
import { Route53DnsProvider } from './route53.js';
import { HetznerDnsProvider } from './hetzner.js';

// Mock providers must be singletons — they store state in memory.
// Without caching, each call creates a fresh instance and zones/records are lost.
const mockProviderCache = new Map<string, MockDnsProvider>();

export function createProvider(providerType: string, config: Record<string, unknown>): DnsProviderAdapter {
  switch (providerType) {
    case 'mock': {
      const key = JSON.stringify(config);
      let mock = mockProviderCache.get(key);
      if (!mock) {
        mock = new MockDnsProvider(config as unknown as MockConfig);
        mockProviderCache.set(key, mock);
      }
      return mock;
    }
    case 'powerdns':
      return new PowerDnsProvider(config as unknown as PowerDnsConfig);
    case 'rndc':
      return new RndcDnsProvider(config as unknown as RndcConfig);
    case 'cloudflare':
      return new CloudflareDnsProvider(config as unknown as CloudflareConfig);
    case 'route53':
      return new Route53DnsProvider(config as unknown as Route53Config);
    case 'hetzner':
      return new HetznerDnsProvider(config as unknown as HetznerDnsConfig);
    default:
      throw new Error(`Unknown DNS provider type: ${providerType}`);
  }
}
