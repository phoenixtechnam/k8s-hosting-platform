import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { signExportToken, verifyExportToken } from './export-token.js';

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const KEY = '0'.repeat(64); // 32 bytes hex

describe('signExportToken / verifyExportToken', () => {
  it('round-trips bundleId + format + null password', () => {
    const token = signExportToken({ bundleId: 'bkp-1', format: 'tar' }, KEY);
    const r = verifyExportToken(token, 'bkp-1', KEY);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.bundleId).toBe('bkp-1');
      expect(r.value.format).toBe('tar');
      expect(r.value.password).toBeNull();
    }
  });

  it('round-trips a password through the AES-256-GCM envelope', () => {
    const token = signExportToken({ bundleId: 'bkp-2', format: 'zip', password: 's3cret' }, KEY);
    const r = verifyExportToken(token, 'bkp-2', KEY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.password).toBe('s3cret');
  });

  it('rejects a token bound to a different bundleId (BAD_BUNDLE)', () => {
    const token = signExportToken({ bundleId: 'bkp-A', format: 'tar' }, KEY);
    const r = verifyExportToken(token, 'bkp-B', KEY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('BAD_BUNDLE');
  });

  it('rejects a token signed with a different key (BAD_MAC)', () => {
    const token = signExportToken({ bundleId: 'bkp-1', format: 'tar' }, KEY);
    const otherKey = '1'.repeat(64);
    const r = verifyExportToken(token, 'bkp-1', otherKey);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('BAD_MAC');
  });

  it('rejects an expired token (EXPIRED)', () => {
    const token = signExportToken({ bundleId: 'bkp-1', format: 'tar' }, KEY, 1);
    const future = Date.now() + 60_000;
    const r = verifyExportToken(token, 'bkp-1', KEY, future);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('EXPIRED');
  });

  it('rejects a tampered payload (BAD_MAC)', () => {
    const token = signExportToken({ bundleId: 'bkp-1', format: 'tar' }, KEY);
    // Flip a single character in the payload portion
    const dot = token.indexOf('.');
    const flipped = (token[0] === 'A' ? 'B' : 'A') + token.slice(1, dot) + token.slice(dot);
    const r = verifyExportToken(flipped, 'bkp-1', KEY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('BAD_MAC');
  });

  it('rejects a malformed token shape', () => {
    const r = verifyExportToken('garbage-no-separator', 'bkp-1', KEY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('MALFORMED');
  });

  it('treats an empty password as null (plaintext download)', () => {
    const token = signExportToken({ bundleId: 'bkp-1', format: 'tar', password: '' }, KEY);
    const r = verifyExportToken(token, 'bkp-1', KEY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.password).toBeNull();
  });

  it('encodes a unicode + special-char password without corruption', () => {
    const password = 'pässw0rd-with-!@#$%^&*()_+你好';
    const token = signExportToken({ bundleId: 'bkp-uni', format: 'tar', password }, KEY);
    const r = verifyExportToken(token, 'bkp-uni', KEY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.password).toBe(password);
  });

  it('produces distinct tokens for the same input (nonce randomness)', () => {
    const t1 = signExportToken({ bundleId: 'bkp-1', format: 'tar', password: 'x' }, KEY);
    const t2 = signExportToken({ bundleId: 'bkp-1', format: 'tar', password: 'x' }, KEY);
    expect(t1).not.toBe(t2);
  });

  it('throws on a non-32-byte key (sign side)', () => {
    expect(() => signExportToken({ bundleId: 'bkp-1', format: 'tar' }, '0'.repeat(8))).toThrow(/32 bytes/);
  });

  it('throws on a non-32-byte key (verify side)', () => {
    const token = signExportToken({ bundleId: 'bkp-1', format: 'tar' }, KEY);
    expect(() => verifyExportToken(token, 'bkp-1', '0'.repeat(8))).toThrow(/32 bytes/);
  });

  it('rejects a payload with an unknown version (BAD_VERSION)', () => {
    // Hand-craft a token whose payload has v:99 but signed with the right key.
    const payload = { v: 99, b: 'bkp-1', f: 'tar', p: null, e: Date.now() + 60_000, n: 'aa' };
    const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
    const macB64 = b64url(createHmac('sha256', Buffer.from(KEY, 'hex')).update(payloadB64).digest());
    const token = `${payloadB64}.${macB64}`;
    const r = verifyExportToken(token, 'bkp-1', KEY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('BAD_VERSION');
  });

  it('rejects a token with an unparseable MAC (MALFORMED)', () => {
    const token = signExportToken({ bundleId: 'bkp-1', format: 'tar' }, KEY);
    const dot = token.indexOf('.');
    // Replace MAC with a string that contains an invalid base64url char
    const broken = `${token.slice(0, dot)}.????`;
    const r = verifyExportToken(broken, 'bkp-1', KEY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(['BAD_MAC', 'MALFORMED']).toContain(r.error.code);
  });

  it('rejects a token whose payload is not valid JSON (MALFORMED)', () => {
    // Build a token where payload base64 decodes to non-JSON garbage, but the MAC matches.
    const payloadB64 = 'bm90LWpzb24'; // base64url("not-json")
    const macB64 = b64url(createHmac('sha256', Buffer.from(KEY, 'hex')).update(payloadB64).digest());
    const token = `${payloadB64}.${macB64}`;
    const r = verifyExportToken(token, 'bkp-1', KEY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('MALFORMED');
  });
});
