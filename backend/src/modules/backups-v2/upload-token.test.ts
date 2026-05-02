import { describe, it, expect } from 'vitest';
import { signUploadToken, verifyUploadToken } from './upload-token.js';

const KEY = 'a'.repeat(64);
const VALID = {
  bundleId: 'bkp-abc',
  component: 'files' as const,
  artifactName: 'archive.tar.gz',
  ttlSeconds: 1800,
};

describe('upload-token', () => {
  it('round-trips a valid token', () => {
    const token = signUploadToken(VALID, KEY);
    expect(verifyUploadToken(token, VALID, KEY)).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = signUploadToken({ ...VALID, ttlSeconds: 30 }, KEY);
    // Verify "now" 60s in the future.
    const r = verifyUploadToken(token, VALID, KEY, Date.now() + 60_000);
    expect(r?.code).toBe('EXPIRED');
  });

  it('rejects a tampered MAC', () => {
    const token = signUploadToken(VALID, KEY);
    const tampered = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');
    const r = verifyUploadToken(tampered, VALID, KEY);
    expect(r?.code).toBe('BAD_MAC');
  });

  it('rejects a token bound to a different bundleId (replay defence)', () => {
    const token = signUploadToken(VALID, KEY);
    const r = verifyUploadToken(token, { ...VALID, bundleId: 'bkp-different' }, KEY);
    expect(r?.code).toBe('BAD_MAC');
  });

  it('rejects a token bound to a different component', () => {
    const token = signUploadToken(VALID, KEY);
    const r = verifyUploadToken(token, { ...VALID, component: 'secrets' }, KEY);
    expect(r?.code).toBe('BAD_MAC');
  });

  it('rejects a token bound to a different artifactName', () => {
    const token = signUploadToken(VALID, KEY);
    const r = verifyUploadToken(token, { ...VALID, artifactName: 'tree.jsonl.gz' }, KEY);
    expect(r?.code).toBe('BAD_MAC');
  });

  it('rejects malformed tokens', () => {
    expect(verifyUploadToken('no-separator', VALID, KEY)?.code).toBe('MALFORMED');
    expect(verifyUploadToken('.justmac', VALID, KEY)?.code).toBe('MALFORMED');
    expect(verifyUploadToken('notanumber.deadbeef', VALID, KEY)?.code).toBe('MALFORMED');
  });

  it('rejects when the key is the wrong length', () => {
    expect(() => signUploadToken(VALID, 'short')).toThrow();
    const ok = signUploadToken(VALID, KEY);
    const r = verifyUploadToken(ok, VALID, 'short');
    expect(r?.code).toBe('MALFORMED');
  });
});
