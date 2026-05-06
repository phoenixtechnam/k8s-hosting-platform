/**
 * Unit tests for the DKIM-rotation pure helpers.
 *
 * Full E2E coverage (Stalwart API call + DNS provider push) lives
 * in the integration harness — the helpers here are the parts that
 * matter for correctness in isolation: selector format, Ed25519
 * key shape.
 */

import { describe, it, expect } from 'vitest';
import {
  generateDkimKeyPairEd25519,
  newDkimSelector,
} from './rotate.js';

describe('email-dkim/rotate: generateDkimKeyPairEd25519', () => {
  it('returns PEM-encoded Ed25519 key pair', () => {
    const { privateKey, publicKey } = generateDkimKeyPairEd25519();
    expect(privateKey).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(privateKey).toMatch(/-----END PRIVATE KEY-----\s*$/);
    expect(publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(publicKey).toMatch(/-----END PUBLIC KEY-----\s*$/);
  });

  it('two consecutive calls produce different keys', () => {
    const a = generateDkimKeyPairEd25519();
    const b = generateDkimKeyPairEd25519();
    expect(a.privateKey).not.toEqual(b.privateKey);
    expect(a.publicKey).not.toEqual(b.publicKey);
  });

  it('Ed25519 public key PEM is short (~80 chars not RSA-2048\'s ~400)', () => {
    const { publicKey } = generateDkimKeyPairEd25519();
    // Strip header/footer/whitespace
    const body = publicKey.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');
    // Ed25519 SPKI is ~60 base64 chars (vs RSA-2048's ~400+)
    expect(body.length).toBeLessThan(80);
    expect(body.length).toBeGreaterThan(40);
  });
});

describe('email-dkim/rotate: newDkimSelector', () => {
  it('returns a YYYYMMDDhhmmss-format selector with dkim- prefix', () => {
    const sel = newDkimSelector(new Date('2026-05-06T19:42:33Z').getTime());
    expect(sel).toBe('dkim-20260506194233');
  });

  it('zero-pads single-digit components', () => {
    const sel = newDkimSelector(new Date('2026-01-02T03:04:05Z').getTime());
    expect(sel).toBe('dkim-20260102030405');
  });

  it('second-precision avoids minute-boundary collisions', () => {
    const t = new Date('2026-05-06T19:42:00Z').getTime();
    const a = newDkimSelector(t);
    const b = newDkimSelector(t + 1_000); // 1s later, same minute — DIFFERENT
    const c = newDkimSelector(t + 60_000); // 1min later — DIFFERENT
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  it('selector contains only DNS-safe characters', () => {
    const sel = newDkimSelector();
    // RFC 5321: A-Z, a-z, 0-9, hyphen
    expect(sel).toMatch(/^[a-z0-9-]+$/);
  });
});
