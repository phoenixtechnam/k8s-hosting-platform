import { describe, it, expect } from 'vitest';
import {
  generateSelfSignedCa,
  signClientCert,
  generateCrl,
  generateSerialHex,
  bundlePkcs12,
} from './cert-ops.js';
import { X509Certificate, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('generateSerialHex', () => {
  it('produces 32 hex chars (128 bits)', () => {
    for (let i = 0; i < 10; i++) {
      const s = generateSerialHex();
      expect(s).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('clears the sign bit so the BIGINT representation is positive', () => {
    for (let i = 0; i < 20; i++) {
      const s = generateSerialHex();
      const firstByte = parseInt(s.slice(0, 2), 16);
      // High bit clear (positive BIGINT) AND top nibble non-zero.
      expect(firstByte & 0x80).toBe(0);
      expect(firstByte & 0xf0).not.toBe(0);
    }
  });

  it('is unique across calls (no global state collision)', () => {
    const set = new Set<string>();
    for (let i = 0; i < 200; i++) set.add(generateSerialHex());
    expect(set.size).toBe(200);
  });
});

describe('signClientCert', () => {
  it('signs a cert against the CA, embedding the supplied serial', async () => {
    const ca = await generateSelfSignedCa({
      commonName: 'unit-test-ca',
      validityDays: 30,
    });
    const explicitSerial = '7abc1234567890abcdef1122334455ff';
    const signed = await signClientCert({
      caCertPem: ca.certPem,
      caKeyPem: ca.keyPem,
      commonName: 'alice@example.com',
      validityDays: 30,
      serialHex: explicitSerial,
    });

    expect(signed.serialHex).toBe(explicitSerial);
    const x509 = new X509Certificate(signed.certPem);
    expect(x509.serialNumber.toLowerCase()).toBe(explicitSerial);
    // Subject should contain the requested CN.
    expect(x509.subject).toContain('alice@example.com');
    // Fingerprint matches what we hash locally.
    const computed = createHash('sha256').update(x509.raw).digest('hex');
    expect(signed.fingerprintSha256).toBe(computed);
    // Expiry within the validity window.
    const daysOut = (signed.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(daysOut).toBeGreaterThan(28);
    expect(daysOut).toBeLessThan(31);
  });

  it('auto-generates a fresh serial when one is not supplied', async () => {
    const ca = await generateSelfSignedCa({
      commonName: 'unit-test-ca-2',
      validityDays: 30,
    });
    const a = await signClientCert({
      caCertPem: ca.certPem,
      caKeyPem: ca.keyPem,
      commonName: 'user-a',
      validityDays: 30,
    });
    const b = await signClientCert({
      caCertPem: ca.certPem,
      caKeyPem: ca.keyPem,
      commonName: 'user-b',
      validityDays: 30,
    });
    expect(a.serialHex).not.toBe(b.serialHex);
    expect(a.serialHex).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rejects malformed serial hex', async () => {
    const ca = await generateSelfSignedCa({
      commonName: 'reject-test-ca',
      validityDays: 30,
    });
    await expect(signClientCert({
      caCertPem: ca.certPem,
      caKeyPem: ca.keyPem,
      commonName: 'user',
      validityDays: 30,
      serialHex: 'not hex!',
    })).rejects.toThrow(/invalid serialHex/);
  });
});

describe('generateCrl', () => {
  it('produces an empty CRL when no entries are revoked', async () => {
    const ca = await generateSelfSignedCa({
      commonName: 'crl-test-ca',
      validityDays: 30,
    });
    const { crlPem } = await generateCrl({
      caCertPem: ca.certPem,
      caKeyPem: ca.keyPem,
      crlNumber: 1,
      validityDays: 7,
      revokedEntries: [],
    });
    expect(crlPem).toContain('BEGIN X509 CRL');
    expect(crlPem).toContain('END X509 CRL');

    // Validate with openssl crl -verify against the issuing CA.
    const dir = await mkdtemp(join(tmpdir(), 'crl-empty-'));
    try {
      await writeFile(join(dir, 'crl.pem'), crlPem);
      await writeFile(join(dir, 'ca.pem'), ca.certPem);
      const { stdout } = await execFileAsync('openssl', [
        'crl', '-in', join(dir, 'crl.pem'),
        '-CAfile', join(dir, 'ca.pem'),
        '-noout', '-text',
      ]);
      expect(stdout).toContain('No Revoked Certificates');
      expect(stdout).toContain('X509v3 CRL Number');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lists a revoked serial and binds the configured reason code', async () => {
    const ca = await generateSelfSignedCa({
      commonName: 'crl-revoked-ca',
      validityDays: 30,
    });
    const signed = await signClientCert({
      caCertPem: ca.certPem,
      caKeyPem: ca.keyPem,
      commonName: 'alice',
      validityDays: 30,
    });
    const { crlPem } = await generateCrl({
      caCertPem: ca.certPem,
      caKeyPem: ca.keyPem,
      crlNumber: 2,
      validityDays: 7,
      revokedEntries: [
        { serialHex: signed.serialHex, revokedAt: new Date(), reason: 'keyCompromise' },
      ],
    });
    const dir = await mkdtemp(join(tmpdir(), 'crl-listed-'));
    try {
      await writeFile(join(dir, 'crl.pem'), crlPem);
      await writeFile(join(dir, 'ca.pem'), ca.certPem);
      const { stdout } = await execFileAsync('openssl', [
        'crl', '-in', join(dir, 'crl.pem'),
        '-CAfile', join(dir, 'ca.pem'),
        '-noout', '-text',
      ]);
      // Openssl prints serials uppercase in CRL text.
      expect(stdout.toUpperCase()).toContain(signed.serialHex.toUpperCase());
      expect(stdout).toContain('Key Compromise');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('produces monotonic CRL numbers across regenerations', async () => {
    const ca = await generateSelfSignedCa({
      commonName: 'crl-mono-ca',
      validityDays: 30,
    });
    const crl1 = await generateCrl({
      caCertPem: ca.certPem,
      caKeyPem: ca.keyPem,
      crlNumber: 5,
      validityDays: 7,
      revokedEntries: [],
    });
    const crl2 = await generateCrl({
      caCertPem: ca.certPem,
      caKeyPem: ca.keyPem,
      crlNumber: 9,
      validityDays: 7,
      revokedEntries: [],
    });
    const dir = await mkdtemp(join(tmpdir(), 'crl-mono-'));
    try {
      await writeFile(join(dir, 'crl1.pem'), crl1.crlPem);
      await writeFile(join(dir, 'crl2.pem'), crl2.crlPem);
      const t1 = await execFileAsync('openssl', ['crl', '-in', join(dir, 'crl1.pem'), '-noout', '-text']);
      const t2 = await execFileAsync('openssl', ['crl', '-in', join(dir, 'crl2.pem'), '-noout', '-text']);
      // Match: "X509v3 CRL Number: \n                <number>"
      const num1 = t1.stdout.match(/CRL Number:\s*\n\s*(\d+)/)?.[1];
      const num2 = t2.stdout.match(/CRL Number:\s*\n\s*(\d+)/)?.[1];
      expect(num1).toBe('5');
      expect(num2).toBe('9');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('bundlePkcs12', () => {
  // The empty-password edge case used to fail on OpenSSL 3.x when we
  // routed it through `-passout file:<empty-file>` ("Hmac key length 0
  // invalid" / "Error reading password from BIO"). The fix dispatches
  // to `-passout pass:` for empty and `-passout file:<path>` for
  // non-empty (the latter prevents prefix-injection from user input).
  // This test guards both code paths.
  async function setupCert() {
    const ca = await generateSelfSignedCa({ commonName: 'bundle-test-ca', validityDays: 30 });
    const u = await signClientCert({
      caCertPem: ca.certPem, caKeyPem: ca.keyPem,
      commonName: 'bundle-user', validityDays: 7,
    });
    return { ca, u };
  }

  it('produces a valid .p12 with an empty password', async () => {
    const { ca, u } = await setupCert();
    const bytes = await bundlePkcs12({
      certPem: u.certPem, keyPem: u.keyPem, caCertPem: ca.certPem,
      password: '', friendlyName: 'bundle-user',
    });
    expect(bytes.length).toBeGreaterThan(500);
    // PKCS#12 magic: starts with DER SEQUENCE (0x30, 0x82) for a non-trivial bundle.
    expect(bytes[0]).toBe(0x30);
  });

  it('produces a valid .p12 with a non-empty password', async () => {
    const { ca, u } = await setupCert();
    const bytes = await bundlePkcs12({
      certPem: u.certPem, keyPem: u.keyPem, caCertPem: ca.certPem,
      password: 'test1234', friendlyName: 'bundle-user',
    });
    expect(bytes.length).toBeGreaterThan(500);
    expect(bytes[0]).toBe(0x30);
  });

  it('produces a .p12 with a password containing openssl prefix-injection chars', async () => {
    // Without the file: passout fix this would dereference to /etc/passwd
    // or similar and either fail or use the file contents as password.
    const { ca, u } = await setupCert();
    const bytes = await bundlePkcs12({
      certPem: u.certPem, keyPem: u.keyPem, caCertPem: ca.certPem,
      password: 'file:/etc/passwd', friendlyName: 'bundle-user',
    });
    expect(bytes.length).toBeGreaterThan(500);
  });
});
