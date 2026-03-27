export type { DnsProviderAdapter, DnsZone, DnsRecord, DnsRecordInput, PowerDnsConfig, RndcConfig, CloudflareConfig, Route53Config, HetznerDnsConfig, MockConfig } from './types.js';
export { MockDnsProvider } from './mock.js';
export { PowerDnsProvider } from './powerdns.js';
export { RndcDnsProvider } from './rndc.js';
export { CloudflareDnsProvider } from './cloudflare.js';
export { Route53DnsProvider } from './route53.js';
export { HetznerDnsProvider } from './hetzner.js';

import type { DnsProviderAdapter } from './types.js';
import { MockDnsProvider } from './mock.js';
import { PowerDnsProvider } from './powerdns.js';
import { RndcDnsProvider } from './rndc.js';
import { CloudflareDnsProvider } from './cloudflare.js';
import { Route53DnsProvider } from './route53.js';
import { HetznerDnsProvider } from './hetzner.js';

export function createProvider(providerType: string, config: Record<string, unknown>): DnsProviderAdapter {
  switch (providerType) {
    case 'mock':
      return new MockDnsProvider(config as any);
    case 'powerdns':
      return new PowerDnsProvider(config as any);
    case 'rndc':
      return new RndcDnsProvider(config as any);
    case 'cloudflare':
      return new CloudflareDnsProvider(config as any);
    case 'route53':
      return new Route53DnsProvider(config as any);
    case 'hetzner':
      return new HetznerDnsProvider(config as any);
    default:
      throw new Error(`Unknown DNS provider type: ${providerType}`);
  }
}
