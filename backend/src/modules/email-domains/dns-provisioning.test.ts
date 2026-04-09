import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildEmailDnsRecordsForDisplay } from './dns-provisioning.js';

const MOCK_DKIM_SELECTOR = 'default';
const MOCK_DKIM_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMOCK\n-----END PUBLIC KEY-----';
const MOCK_MAIL_HOSTNAME = 'mail.platform.test';

describe('buildEmailDnsRecordsForDisplay', () => {
  it('includes core mail records without webmail when webmailEnabled is false or absent', () => {
    const records = buildEmailDnsRecordsForDisplay(
      'example.com',
      MOCK_DKIM_SELECTOR,
      MOCK_DKIM_PUBLIC_KEY,
      MOCK_MAIL_HOSTNAME,
    );

    // Core records must be present
    expect(records.some((r) => r.purpose === 'mx')).toBe(true);
    expect(records.some((r) => r.purpose === 'dkim')).toBe(true);
    expect(records.some((r) => r.purpose === 'spf')).toBe(true);
    expect(records.some((r) => r.purpose === 'dmarc')).toBe(true);
    // Webmail record must be absent
    expect(records.some((r) => r.purpose === 'webmail')).toBe(false);
  });

  it('adds a webmail.<domain> A record when webmailEnabled is true', () => {
    const records = buildEmailDnsRecordsForDisplay(
      'example.com',
      MOCK_DKIM_SELECTOR,
      MOCK_DKIM_PUBLIC_KEY,
      MOCK_MAIL_HOSTNAME,
      { webmailEnabled: true },
    );

    const webmail = records.find((r) => r.purpose === 'webmail');
    expect(webmail).toBeDefined();
    expect(webmail?.recordType).toBe('A');
    expect(webmail?.recordName).toBe('webmail.example.com');
    expect(webmail?.ttl).toBe(3600);
  });

  it('tags every record with a `purpose` field so the UI can group them', () => {
    const records = buildEmailDnsRecordsForDisplay(
      'example.com',
      MOCK_DKIM_SELECTOR,
      MOCK_DKIM_PUBLIC_KEY,
      MOCK_MAIL_HOSTNAME,
      { webmailEnabled: true },
    );
    for (const r of records) {
      expect(typeof r.purpose).toBe('string');
      expect(r.purpose.length).toBeGreaterThan(0);
    }
  });

  it('does NOT add the webmail record when webmailEnabled is explicitly false', () => {
    const records = buildEmailDnsRecordsForDisplay(
      'example.com',
      MOCK_DKIM_SELECTOR,
      MOCK_DKIM_PUBLIC_KEY,
      MOCK_MAIL_HOSTNAME,
      { webmailEnabled: false },
    );
    expect(records.some((r) => r.purpose === 'webmail')).toBe(false);
  });

  // Round-4 Phase 1: deterministic MTA-STS policy id (regression
  // guard against accidentally going back to Date.now()).
  it('produces a stable mta_sts policy id across calls for the same domain', () => {
    const r1 = buildEmailDnsRecordsForDisplay('example.com', 'default', 'pub', 'mail.host');
    const r2 = buildEmailDnsRecordsForDisplay('example.com', 'default', 'pub', 'mail.host');
    const id1 = r1.find((r) => r.purpose === 'mta_sts' && r.recordType === 'TXT')?.recordValue;
    const id2 = r2.find((r) => r.purpose === 'mta_sts' && r.recordType === 'TXT')?.recordValue;
    expect(id1).toBeDefined();
    expect(id1).toBe(id2);
  });
});

// Round-4 Phase 1: MAIL_SERVER_IP fallback chain
describe('MAIL_SERVER_IP fallback chain', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  beforeEach(() => {
    delete process.env.MAIL_SERVER_IP;
    delete process.env.INGRESS_DEFAULT_IPV4;
  });

  it('uses MAIL_SERVER_IP when set', () => {
    process.env.MAIL_SERVER_IP = '203.0.113.42';
    const records = buildEmailDnsRecordsForDisplay('example.com', 'default', 'pub', 'mail.host', {
      webmailEnabled: true,
    });
    const webmail = records.find((r) => r.purpose === 'webmail');
    expect(webmail?.recordValue).toBe('203.0.113.42');
  });

  it('falls back to INGRESS_DEFAULT_IPV4 when MAIL_SERVER_IP is unset', () => {
    process.env.INGRESS_DEFAULT_IPV4 = '198.51.100.7';
    const records = buildEmailDnsRecordsForDisplay('example.com', 'default', 'pub', 'mail.host', {
      webmailEnabled: true,
    });
    const webmail = records.find((r) => r.purpose === 'webmail');
    expect(webmail?.recordValue).toBe('198.51.100.7');
  });

  it('prefers MAIL_SERVER_IP over INGRESS_DEFAULT_IPV4', () => {
    process.env.MAIL_SERVER_IP = '203.0.113.42';
    process.env.INGRESS_DEFAULT_IPV4 = '198.51.100.7';
    const records = buildEmailDnsRecordsForDisplay('example.com', 'default', 'pub', 'mail.host', {
      webmailEnabled: true,
    });
    const webmail = records.find((r) => r.purpose === 'webmail');
    expect(webmail?.recordValue).toBe('203.0.113.42');
  });

  it('falls back to 127.0.0.1 when neither env var is set', () => {
    const records = buildEmailDnsRecordsForDisplay('example.com', 'default', 'pub', 'mail.host', {
      webmailEnabled: true,
    });
    const webmail = records.find((r) => r.purpose === 'webmail');
    expect(webmail?.recordValue).toBe('127.0.0.1');
  });

  // Review round-4 HIGH-1: empty-string env var must be treated as
  // unset, not as a valid override. Otherwise `MAIL_SERVER_IP=` in a
  // Compose file silently dropped to 127.0.0.1.
  it('treats an empty MAIL_SERVER_IP as unset and falls through to INGRESS_DEFAULT_IPV4', () => {
    process.env.MAIL_SERVER_IP = '';
    process.env.INGRESS_DEFAULT_IPV4 = '198.51.100.7';
    const records = buildEmailDnsRecordsForDisplay('example.com', 'default', 'pub', 'mail.host', {
      webmailEnabled: true,
    });
    const webmail = records.find((r) => r.purpose === 'webmail');
    expect(webmail?.recordValue).toBe('198.51.100.7');
  });

  it('treats whitespace-only env var as unset', () => {
    process.env.MAIL_SERVER_IP = '   ';
    process.env.INGRESS_DEFAULT_IPV4 = '198.51.100.7';
    const records = buildEmailDnsRecordsForDisplay('example.com', 'default', 'pub', 'mail.host', {
      webmailEnabled: true,
    });
    const webmail = records.find((r) => r.purpose === 'webmail');
    expect(webmail?.recordValue).toBe('198.51.100.7');
  });
});
