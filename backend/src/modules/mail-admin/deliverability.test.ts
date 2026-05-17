/**
 * Unit tests for the deliverability probe set.
 *
 * Coverage strategy: every sub-probe is driven by an injected resolver/
 * connector override so the test never touches real DNS, TLS, or sockets.
 * Each probe is exercised on (a) happy path, (b) the operationally-
 * interesting failure mode, and (c) network-layer errors.
 *
 * For helpers exported from the module (blocklistQueryName, matchSan,
 * parseSanDnsNames, banner/EHLO extractors), pure unit tests verify
 * edge cases.
 */

import { describe, expect, it } from 'vitest';
import {
  blocklistQueryName,
  extractBannerHostname,
  extractEhloHostname,
  matchSan,
  parseSanDnsNames,
  probeDeliverability,
  type DeliverabilityDeps,
} from './deliverability.js';

function makeDeps(overrides: Partial<DeliverabilityDeps>): DeliverabilityDeps {
  return {
    hostname: 'mail.example.com',
    serverNodeIps: ['198.51.100.10'],
    // Defaults: every override resolves to a "clean" / "happy" state.
    resolveAddresses: async (h) => h === 'mail.example.com' ? { a: ['198.51.100.10'], aaaa: [] } : { a: [], aaaa: [] },
    resolvePtr: async (_ip) => ['mail.example.com'],
    resolveBlocklist: async () => ({ listed: false, reasonTxt: null }),
    tlsConnect: async () => ({
      peerCertificate: { subjectaltname: 'DNS:mail.example.com, DNS:*.example.com' } as never,
      error: null,
    }),
    smtpBannerExchange: async () => ({
      banner: '220 mail.example.com ESMTP Stalwart',
      ehloLine: '250-mail.example.com offers',
      error: null,
    }),
    ...overrides,
  };
}

describe('probeDeliverability — top-level wiring', () => {
  it('returns not_implemented when hostname is missing', async () => {
    const r = await probeDeliverability(makeDeps({ hostname: null }));
    expect(r.status).toBe('not_implemented');
    expect(r.healthy).toBe(true);
    expect(r.summary.skipped).toBeGreaterThan(0);
  });

  it('returns not_implemented when there are no server IPs', async () => {
    const r = await probeDeliverability(makeDeps({ serverNodeIps: [] }));
    expect(r.status).toBe('not_implemented');
    expect(r.healthy).toBe(true);
    // No server IPs → fixed-count probes only would have run
    // (1 forward DNS + 0 reverse + 0 blocklists + 1 SAN + 1 banner = 3).
    expect(r.summary.skipped).toBe(3);
  });

  it('not_implemented summary counts what WOULD have run (hostname missing, 2 IPs)', async () => {
    const r = await probeDeliverability(makeDeps({
      hostname: null,
      serverNodeIps: ['198.51.100.10', '198.51.100.11'],
    }));
    expect(r.status).toBe('not_implemented');
    // 1 forward + 2 reverse + 2×8 blocklists + 1 SAN + 1 banner = 21
    expect(r.summary.skipped).toBe(21);
  });

  it('reports ok with summary when everything passes', async () => {
    const r = await probeDeliverability(makeDeps({}));
    expect(r.status).toBe('ok');
    expect(r.healthy).toBe(true);
    expect(r.summary.fail).toBe(0);
    expect(r.summary.ok).toBeGreaterThan(0);
    // Verify each sub-probe is populated
    expect(r.forwardDns?.severity).toBe('ok');
    expect(r.reverseDns).toHaveLength(1);
    expect(r.reverseDns[0].severity).toBe('ok');
    expect(r.blocklists.length).toBeGreaterThan(0);
    expect(r.certSanMatch?.severity).toBe('ok');
    expect(r.smtpBanner?.severity).toBe('ok');
  });

  it('flips healthy=false when any sub-probe is fail', async () => {
    const r = await probeDeliverability(makeDeps({
      resolvePtr: async () => ['someone-else.example.com'],
    }));
    expect(r.healthy).toBe(false);
    expect(r.summary.fail).toBeGreaterThan(0);
    expect(r.error).toMatch(/deliverability failure/);
  });
});

describe('forward DNS probe', () => {
  it('fails when expected IP is missing from resolution', async () => {
    const r = await probeDeliverability(makeDeps({
      serverNodeIps: ['198.51.100.10', '198.51.100.11'],
      resolveAddresses: async () => ({ a: ['198.51.100.10'], aaaa: [] }),
    }));
    expect(r.forwardDns?.severity).toBe('fail');
    expect(r.forwardDns?.missingIps).toEqual(['198.51.100.11']);
    expect(r.forwardDns?.remediation).toMatch(/Add A record/);
  });

  it('warns when DNS resolves to extra unexpected IPs', async () => {
    const r = await probeDeliverability(makeDeps({
      resolveAddresses: async () => ({ a: ['198.51.100.10', '203.0.113.99'], aaaa: [] }),
    }));
    expect(r.forwardDns?.severity).toBe('warning');
    expect(r.forwardDns?.extraIps).toEqual(['203.0.113.99']);
  });

  it('fails when DNS resolver throws', async () => {
    const r = await probeDeliverability(makeDeps({
      resolveAddresses: async () => { throw new Error('ENOTFOUND'); },
    }));
    expect(r.forwardDns?.severity).toBe('fail');
    expect(r.forwardDns?.actual).toMatch(/ENOTFOUND/);
  });
});

describe('reverse DNS / FCrDNS probe', () => {
  it('reports ok per IP when PTR matches', async () => {
    const r = await probeDeliverability(makeDeps({
      serverNodeIps: ['198.51.100.10', '198.51.100.11'],
      resolveAddresses: async () => ({ a: ['198.51.100.10', '198.51.100.11'], aaaa: [] }),
      resolvePtr: async () => ['mail.example.com'],
    }));
    expect(r.reverseDns).toHaveLength(2);
    expect(r.reverseDns.every((p) => p.severity === 'ok')).toBe(true);
  });

  it('fails when PTR doesn\'t match hostname', async () => {
    const r = await probeDeliverability(makeDeps({
      resolvePtr: async () => ['static-198-51-100-10.isp.example.net'],
    }));
    expect(r.reverseDns[0].severity).toBe('fail');
    expect(r.reverseDns[0].fcrdnsOk).toBe(false);
    expect(r.reverseDns[0].remediation).toMatch(/Update reverse DNS/);
  });

  it('handles PTR records with trailing dots', async () => {
    const r = await probeDeliverability(makeDeps({
      resolvePtr: async () => ['mail.example.com.'],
    }));
    expect(r.reverseDns[0].severity).toBe('ok');
  });

  it('fails when PTR lookup throws (no PTR configured)', async () => {
    const r = await probeDeliverability(makeDeps({
      resolvePtr: async () => { throw new Error('ENOTFOUND'); },
    }));
    expect(r.reverseDns[0].severity).toBe('fail');
    expect(r.reverseDns[0].remediation).toMatch(/Configure reverse DNS/);
  });
});

describe('DNSBL probes', () => {
  it('produces N×M probes (IPs × blocklists)', async () => {
    const r = await probeDeliverability(makeDeps({
      serverNodeIps: ['198.51.100.10', '198.51.100.11'],
      resolveAddresses: async () => ({ a: ['198.51.100.10', '198.51.100.11'], aaaa: [] }),
    }));
    // 8 lists × 2 IPs = 16
    expect(r.blocklists).toHaveLength(16);
  });

  it('marks Spamhaus ZEN listing as fail', async () => {
    const r = await probeDeliverability(makeDeps({
      resolveBlocklist: async (zone) => ({
        listed: zone === 'zen.spamhaus.org',
        reasonTxt: zone === 'zen.spamhaus.org' ? 'https://www.spamhaus.org/sbl/query/SBL12345' : null,
      }),
    }));
    const zen = r.blocklists.find((b) => b.zone === 'zen.spamhaus.org');
    expect(zen?.severity).toBe('fail');
    expect(zen?.listed).toBe(true);
    expect(zen?.reasonTxt).toMatch(/spamhaus/i);
    expect(r.healthy).toBe(false);
  });

  it('marks UCEPROTECT L1 listing as advisory (doesn\'t flip healthy)', async () => {
    const r = await probeDeliverability(makeDeps({
      resolveBlocklist: async (zone) => ({
        listed: zone === 'dnsbl-1.uceprotect.net',
        reasonTxt: null,
      }),
    }));
    const uce = r.blocklists.find((b) => b.zone === 'dnsbl-1.uceprotect.net');
    expect(uce?.severity).toBe('advisory');
    expect(uce?.listed).toBe(true);
    expect(r.healthy).toBe(true);
    expect(r.summary.fail).toBe(0);
    expect(r.summary.advisory).toBe(1);
  });

  it('marks lookup errors as skipped (not fail)', async () => {
    const r = await probeDeliverability(makeDeps({
      resolveBlocklist: async () => { throw new Error('SERVFAIL'); },
    }));
    expect(r.blocklists.every((b) => b.severity === 'skipped')).toBe(true);
    expect(r.healthy).toBe(true);
  });

  it('treats ENODATA errors as skipped, NOT clean (no false negative)', async () => {
    // Regression: previous version mapped ENODATA → listed:false (clean),
    // which could miss listings on zones that publish CNAME/TXT-only
    // records. After the fix, ENODATA bubbles up and the outer catch
    // reports the probe as `skipped`.
    const r = await probeDeliverability(makeDeps({
      resolveBlocklist: async () => {
        const e = new Error('queryA ENODATA');
        (e as NodeJS.ErrnoException).code = 'ENODATA';
        throw e;
      },
    }));
    expect(r.blocklists.every((b) => b.severity === 'skipped')).toBe(true);
  });
});

describe('cert SAN match probe', () => {
  it('matches exact SAN', async () => {
    const r = await probeDeliverability(makeDeps({
      tlsConnect: async () => ({
        peerCertificate: { subjectaltname: 'DNS:mail.example.com' } as never,
        error: null,
      }),
    }));
    expect(r.certSanMatch?.severity).toBe('ok');
    expect(r.certSanMatch?.matched).toBe(true);
  });

  it('matches wildcard SAN', async () => {
    const r = await probeDeliverability(makeDeps({
      tlsConnect: async () => ({
        peerCertificate: { subjectaltname: 'DNS:*.example.com' } as never,
        error: null,
      }),
    }));
    expect(r.certSanMatch?.severity).toBe('ok');
  });

  it('fails when SAN doesn\'t include hostname', async () => {
    const r = await probeDeliverability(makeDeps({
      tlsConnect: async () => ({
        peerCertificate: { subjectaltname: 'DNS:other.example.com, DNS:another.example.com' } as never,
        error: null,
      }),
    }));
    expect(r.certSanMatch?.severity).toBe('fail');
    expect(r.certSanMatch?.matched).toBe(false);
    expect(r.certSanMatch?.remediation).toMatch(/SubjectAltName/);
  });

  it('fails when TLS connector returns an error', async () => {
    const r = await probeDeliverability(makeDeps({
      tlsConnect: async () => ({ peerCertificate: null, error: 'ECONNREFUSED' }),
    }));
    expect(r.certSanMatch?.severity).toBe('fail');
    expect(r.certSanMatch?.actual).toMatch(/ECONNREFUSED/);
  });
});

describe('SMTP banner / EHLO probe', () => {
  it('reports ok when banner + EHLO both match hostname', async () => {
    const r = await probeDeliverability(makeDeps({
      smtpBannerExchange: async () => ({
        banner: '220 mail.example.com ESMTP Stalwart 0.16.0',
        ehloLine: '250-mail.example.com offers',
        error: null,
      }),
    }));
    expect(r.smtpBanner?.severity).toBe('ok');
    expect(r.smtpBanner?.bannerMatches).toBe(true);
    expect(r.smtpBanner?.ehloMatches).toBe(true);
  });

  it('fails when banner hostname differs from configured', async () => {
    const r = await probeDeliverability(makeDeps({
      smtpBannerExchange: async () => ({
        banner: '220 some-other-host.local ESMTP Stalwart',
        ehloLine: '250-some-other-host.local',
        error: null,
      }),
    }));
    expect(r.smtpBanner?.severity).toBe('fail');
    expect(r.smtpBanner?.remediation).toMatch(/defaultHostname/);
  });

  it('skips when SMTP exchange returns connection error', async () => {
    const r = await probeDeliverability(makeDeps({
      smtpBannerExchange: async () => ({ banner: null, ehloLine: null, error: 'ECONNREFUSED' }),
    }));
    expect(r.smtpBanner?.severity).toBe('skipped');
    expect(r.healthy).toBe(true); // skipped doesn't flip healthy
  });
});

describe('blocklistQueryName', () => {
  it('reverses IPv4 octets', () => {
    expect(blocklistQueryName('1.2.3.4', 'zen.spamhaus.org'))
      .toBe('4.3.2.1.zen.spamhaus.org');
  });

  it('handles IPv6 (best-effort)', () => {
    const q = blocklistQueryName('2001:db8::1', 'zen.spamhaus.org');
    expect(q).toMatch(/zen\.spamhaus\.org$/);
    // Reversed nibbles end with the zone
    expect(q.split('.').length).toBeGreaterThan(30);
  });

  it('throws on invalid IPv4', () => {
    expect(() => blocklistQueryName('notanip', 'z.example.com')).toThrow();
  });

  it('rejects IPv6 with zone-ID suffix', () => {
    // Link-local zone IDs (e.g. fe80::1%eth0) would otherwise produce
    // a garbled query name and silently NXDOMAIN. Better to throw and
    // let the outer catch mark the probe as `skipped`.
    expect(() => blocklistQueryName('fe80::1%eth0', 'zen.spamhaus.org')).toThrow(/zone ID/);
  });
});

describe('parseSanDnsNames', () => {
  it('extracts DNS entries from Node\'s subjectaltname format', () => {
    expect(parseSanDnsNames('DNS:a.example.com, DNS:b.example.com, IP Address:1.2.3.4'))
      .toEqual(['a.example.com', 'b.example.com']);
  });

  it('lowercases entries', () => {
    expect(parseSanDnsNames('DNS:Mail.Example.COM'))
      .toEqual(['mail.example.com']);
  });

  it('handles empty input', () => {
    expect(parseSanDnsNames('')).toEqual([]);
  });
});

describe('matchSan', () => {
  it('matches exact hostname', () => {
    expect(matchSan('mail.example.com', ['mail.example.com'])).toBe(true);
  });

  it('matches wildcard prefix', () => {
    expect(matchSan('mail.example.com', ['*.example.com'])).toBe(true);
  });

  it('does NOT match wildcard across multiple labels', () => {
    // *.example.com matches mail.example.com but not deep.mail.example.com (RFC 6125)
    expect(matchSan('deep.mail.example.com', ['*.example.com'])).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(matchSan('MAIL.EXAMPLE.COM', ['mail.example.com'])).toBe(true);
  });

  it('does NOT match if hostname has no dot', () => {
    expect(matchSan('localhost', ['*.example.com'])).toBe(false);
  });
});

describe('banner / EHLO extractors', () => {
  it('extracts banner hostname after 220', () => {
    expect(extractBannerHostname('220 mail.example.com ESMTP Stalwart 0.16')).toBe('mail.example.com');
  });

  it('extracts banner hostname even with dash separator', () => {
    expect(extractBannerHostname('220-mail.example.com')).toBe('mail.example.com');
  });

  it('returns null for non-220 lines', () => {
    expect(extractBannerHostname('500 oops')).toBeNull();
    expect(extractBannerHostname(null)).toBeNull();
  });

  it('extracts EHLO hostname after 250-', () => {
    expect(extractEhloHostname('250-mail.example.com offers')).toBe('mail.example.com');
  });

  it('extracts EHLO hostname after 250 (space)', () => {
    expect(extractEhloHostname('250 mail.example.com')).toBe('mail.example.com');
  });
});
