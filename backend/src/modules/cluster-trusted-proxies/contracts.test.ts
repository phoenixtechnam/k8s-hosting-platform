import { describe, expect, it } from 'vitest';
import { createTrustedProxyRangeRequestSchema } from '@k8s-hosting/api-contracts';

describe('createTrustedProxyRangeRequestSchema — CIDR validation', () => {
  const good = (cidr: string) => ({ cidr, description: 'x' });

  it.each([
    '1.2.3.4',
    '10.0.0.0/8',
    '203.0.113.0/24',
    '255.255.255.255/32',
    '127.0.0.1/32',
    '2001:db8::1',
    '2001:db8::/32',
    'fd00::/8',
    '::1',
    '::1/128',
    'fe80::1/64',
  ])('accepts %s', (cidr) => {
    expect(createTrustedProxyRangeRequestSchema.safeParse(good(cidr)).success).toBe(true);
  });

  it.each([
    // /0 — the trust footgun
    '0.0.0.0/0',
    '10.0.0.0/0',
    '::/0',
    '2001:db8::/0',
    // Octet > 255
    '999.999.999.999/24',
    '256.0.0.0/8',
    '300.300.300.300',
    // Malformed
    'not-an-ip',
    '10.0.0',
    '10.0.0.0.0',
    '10.0.0.0/33',
    '10.0.0.0/-1',
    // IPv6 garbage
    'zz::',
    ':::::',
    '2001:db8::/129',
    // Empty / whitespace
    '',
    '   ',
    // Injection attempts (must NOT pass — defence in depth even though
    // renderNginxSnippet doesn't emit description, the CIDR field could
    // land in nginx if regex were ever loosened)
    '10.0.0.0/8;evil',
    '10.0.0.0/8\nset_real_ip_from 0.0.0.0/0',
    '10.0.0.0/8 # comment',
  ])('rejects %s', (cidr) => {
    expect(createTrustedProxyRangeRequestSchema.safeParse(good(cidr)).success).toBe(false);
  });

  it('rejects empty description', () => {
    const r = createTrustedProxyRangeRequestSchema.safeParse({ cidr: '10.0.0.0/8', description: '' });
    expect(r.success).toBe(false);
  });

  it('rejects oversized description (>200 chars)', () => {
    const r = createTrustedProxyRangeRequestSchema.safeParse({
      cidr: '10.0.0.0/8',
      description: 'x'.repeat(201),
    });
    expect(r.success).toBe(false);
  });
});
