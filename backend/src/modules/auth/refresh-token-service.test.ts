import { describe, it, expect } from 'vitest';
import { hashRefreshToken, generateRefreshToken } from './refresh-token-service.js';

// Pure-function tests for refresh-token-service. The DB-touching
// scenarios (issue/validate/rotate/reuse-detection/prune) live in
// refresh-token-service.integration.test.ts which requires a real
// postgres at DATABASE_URL.

describe('refresh-token-service (pure)', () => {
  it('hashRefreshToken is deterministic and 64-char hex', () => {
    const hash = hashRefreshToken('test-token');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashRefreshToken('test-token')).toBe(hash);
  });

  it('hashRefreshToken differs for different inputs', () => {
    expect(hashRefreshToken('a')).not.toBe(hashRefreshToken('b'));
  });

  it('generateRefreshToken returns base64url-safe 256-bit values', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes → 43 chars base64url (no padding)
    expect(a.length).toBeGreaterThanOrEqual(43);
  });
});
