import { describe, expect, it } from 'vitest';
import { getOperatorIp, isOperatorIpTrusted } from './crowdsec-l4.js';

describe('getOperatorIp', () => {
  it('reads X-Real-IP header (string)', () => {
    expect(getOperatorIp({ headers: { 'x-real-ip': '1.2.3.4' } })).toBe('1.2.3.4');
  });

  it('reads X-Real-IP header (array — Fastify wraps duplicates)', () => {
    expect(getOperatorIp({ headers: { 'x-real-ip': ['1.2.3.4', '5.6.7.8'] } })).toBe('1.2.3.4');
  });

  it('falls back to req.ip when header missing', () => {
    expect(getOperatorIp({ ip: '10.20.30.40' })).toBe('10.20.30.40');
  });

  it('prefers header over req.ip', () => {
    expect(getOperatorIp({ headers: { 'x-real-ip': '1.2.3.4' }, ip: '10.0.0.1' })).toBe('1.2.3.4');
  });

  it('returns null on malformed IP', () => {
    expect(getOperatorIp({ headers: { 'x-real-ip': 'not-an-ip' } })).toBeNull();
    expect(getOperatorIp({ headers: { 'x-real-ip': '999.999.999.999' } })).toBeNull();
  });

  it('returns null when neither source has a value', () => {
    expect(getOperatorIp({})).toBeNull();
    expect(getOperatorIp({ headers: {} })).toBeNull();
  });

  it('accepts IPv6', () => {
    expect(getOperatorIp({ headers: { 'x-real-ip': '2001:db8::1' } })).toBe('2001:db8::1');
  });

  it('rejects whitespace-only header', () => {
    expect(getOperatorIp({ headers: { 'x-real-ip': '   ' } })).toBeNull();
  });
});

describe('isOperatorIpTrusted — IPv4', () => {
  const sources = {
    trustedRangesV4: ['10.0.0.0/8', '192.168.1.0/24'],
    trustedRangesV6: [],
    clusterPeersV4: ['172.16.0.5', '172.16.0.6'],
    clusterPeersV6: [],
  };

  it('matches exact cluster peer', () => {
    expect(isOperatorIpTrusted('172.16.0.5', sources)).toBe(true);
  });

  it('matches IP inside trusted range /8', () => {
    expect(isOperatorIpTrusted('10.99.88.77', sources)).toBe(true);
  });

  it('matches IP inside trusted range /24', () => {
    expect(isOperatorIpTrusted('192.168.1.5', sources)).toBe(true);
  });

  it('rejects IP outside all ranges', () => {
    expect(isOperatorIpTrusted('1.2.3.4', sources)).toBe(false);
  });

  it('rejects IP one beyond /24 boundary', () => {
    expect(isOperatorIpTrusted('192.168.2.1', sources)).toBe(false);
  });

  it('rejects null IP', () => {
    expect(isOperatorIpTrusted(null, sources)).toBe(false);
  });

  it('rejects malformed IP string', () => {
    expect(isOperatorIpTrusted('not-an-ip', sources)).toBe(false);
  });
});

describe('isOperatorIpTrusted — IPv6', () => {
  const sources = {
    trustedRangesV4: [],
    trustedRangesV6: ['2001:db8::/32', 'fd00::/8'],
    clusterPeersV4: [],
    clusterPeersV6: ['fe80::1', 'fe80::abcd'],
  };

  it('matches exact v6 cluster peer', () => {
    expect(isOperatorIpTrusted('fe80::1', sources)).toBe(true);
  });

  it('matches v6 inside trusted /32', () => {
    expect(isOperatorIpTrusted('2001:db8::1234', sources)).toBe(true);
  });

  it('matches v6 inside trusted /8', () => {
    expect(isOperatorIpTrusted('fd12::1', sources)).toBe(true);
  });

  it('rejects v6 outside all ranges', () => {
    expect(isOperatorIpTrusted('2001:db9::1', sources)).toBe(false);
  });

  it('handles :: shorthand', () => {
    expect(isOperatorIpTrusted('::1', sources)).toBe(false);
  });

  it('does NOT match v4 against v6 ranges', () => {
    expect(isOperatorIpTrusted('192.168.1.1', sources)).toBe(false);
  });
});

describe('isOperatorIpTrusted — fail-CLOSED on empty sources', () => {
  it('empty sources → never trusted', () => {
    const sources = {
      trustedRangesV4: [],
      trustedRangesV6: [],
      clusterPeersV4: [],
      clusterPeersV6: [],
    };
    expect(isOperatorIpTrusted('1.2.3.4', sources)).toBe(false);
    expect(isOperatorIpTrusted('::1', sources)).toBe(false);
  });
});

describe('isOperatorIpTrusted — malformed CIDR ignored', () => {
  it('malformed /99 v4 → no match (silent skip, not throw)', () => {
    const sources = {
      trustedRangesV4: ['10.0.0.0/99'],
      trustedRangesV6: [],
      clusterPeersV4: [],
      clusterPeersV6: [],
    };
    expect(isOperatorIpTrusted('10.0.0.1', sources)).toBe(false);
  });

  it('malformed CIDR with no slash → no match', () => {
    const sources = {
      trustedRangesV4: ['not-a-cidr'],
      trustedRangesV6: [],
      clusterPeersV4: [],
      clusterPeersV6: [],
    };
    expect(isOperatorIpTrusted('1.2.3.4', sources)).toBe(false);
  });
});
