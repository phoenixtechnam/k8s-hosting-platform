import { describe, it, expect } from 'vitest';
import { generateDkimKeyPair, formatDkimDnsValue } from './dkim.js';

describe('generateDkimKeyPair', () => {
  it('should generate a valid RSA key pair', () => {
    const { privateKey, publicKey } = generateDkimKeyPair();

    expect(privateKey).toContain('-----BEGIN PRIVATE KEY-----');
    expect(privateKey).toContain('-----END PRIVATE KEY-----');
    expect(publicKey).toContain('-----BEGIN PUBLIC KEY-----');
    expect(publicKey).toContain('-----END PUBLIC KEY-----');
  });

  it('should generate a valid PEM public key', () => {
    const { publicKey } = generateDkimKeyPair();

    // Remove headers/footers and whitespace, verify base64
    const base64 = publicKey
      .replace(/-----BEGIN PUBLIC KEY-----/g, '')
      .replace(/-----END PUBLIC KEY-----/g, '')
      .replace(/\s/g, '');

    expect(base64.length).toBeGreaterThan(0);
    expect(() => Buffer.from(base64, 'base64')).not.toThrow();
  });

  it('should generate unique keys each time', () => {
    const pair1 = generateDkimKeyPair();
    const pair2 = generateDkimKeyPair();

    expect(pair1.privateKey).not.toEqual(pair2.privateKey);
    expect(pair1.publicKey).not.toEqual(pair2.publicKey);
  });
});

describe('formatDkimDnsValue', () => {
  it('should produce correct DKIM DNS TXT format', () => {
    const { publicKey } = generateDkimKeyPair();
    const dnsValue = formatDkimDnsValue(publicKey);

    expect(dnsValue).toMatch(/^v=DKIM1; k=rsa; p=[A-Za-z0-9+/=]+$/);
  });

  it('should not contain PEM headers', () => {
    const { publicKey } = generateDkimKeyPair();
    const dnsValue = formatDkimDnsValue(publicKey);

    expect(dnsValue).not.toContain('-----BEGIN PUBLIC KEY-----');
    expect(dnsValue).not.toContain('-----END PUBLIC KEY-----');
  });

  it('should not contain newlines or spaces in the key portion', () => {
    const { publicKey } = generateDkimKeyPair();
    const dnsValue = formatDkimDnsValue(publicKey);

    // Extract just the key portion after "p="
    const keyPortion = dnsValue.split('p=')[1];
    expect(keyPortion).not.toContain('\n');
    expect(keyPortion).not.toContain('\r');
    expect(keyPortion).not.toContain(' ');
  });
});
