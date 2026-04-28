import { describe, it, expect } from 'vitest';
import { parseCaCert } from './service.js';
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

function generateSelfSignedPem(): string {
  // Use openssl to mint a one-shot self-signed cert for the test.
  // Avoids pulling in another crypto library; the platform image
  // already has openssl available, and CI containers do too.
  const dir = mkdtempSync(join(tmpdir(), 'mtls-test-'));
  execSync(
    `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${dir}/k.pem" -out "${dir}/c.pem" -days 365 -subj "/CN=test-mtls-ca/O=Test Co"`,
    { stdio: 'pipe' },
  );
  return readFileSync(join(dir, 'c.pem'), 'utf-8');
}

describe('parseCaCert', () => {
  it('extracts fingerprint, subject, expiry from a real PEM', () => {
    const pem = generateSelfSignedPem();
    const meta = parseCaCert(pem);
    expect(meta).not.toBeNull();
    expect(meta!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(meta!.subject).toContain('CN=test-mtls-ca');
    expect(meta!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    // Expiry should be ~365 days out (allow a 1-day fudge for the
    // openssl command's notBefore/notAfter rounding).
    const daysUntilExpiry = Math.round(
      (meta!.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000),
    );
    expect(daysUntilExpiry).toBeGreaterThan(360);
    expect(daysUntilExpiry).toBeLessThan(370);
  });

  it('returns null on garbage input', () => {
    expect(parseCaCert('not a pem')).toBeNull();
    expect(parseCaCert('-----BEGIN CERTIFICATE-----\nbad\n-----END CERTIFICATE-----')).toBeNull();
  });

  it('only inspects the first cert when given a bundle', () => {
    const a = generateSelfSignedPem();
    const b = generateSelfSignedPem();
    const bundle = a + '\n' + b;
    const meta = parseCaCert(bundle);
    expect(meta).not.toBeNull();
    // Bundle's first cert is `a` — check that we didn't accidentally
    // hash the whole bundle or the second cert.
    const first = parseCaCert(a);
    expect(meta!.fingerprint).toBe(first!.fingerprint);
  });
});
