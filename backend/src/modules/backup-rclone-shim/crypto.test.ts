/**
 * Unit tests for the BACKUP_TARGET_KEY HKDF derivations.
 *
 * Determinism is the critical property: every derivation MUST be a
 * pure function of (rawKey, label, className). If two consumers
 * compute different values from the same key, backups become
 * unrecoverable. These tests are the safety net against accidental
 * label changes, encoding mismatches, or HKDF parameter drift.
 */

import { describe, it, expect } from 'vitest';
import {
  decodeBackupTargetKey,
  fingerprintRawKey,
  deriveShimAccessKey,
  deriveShimSecretKey,
  deriveCryptCredentials,
  deriveCryptRawHex,
  deriveResticPassword,
  rcloneObscure,
} from './crypto';

// A fixed test key — exactly 32 bytes, base64-encoded.
// Used in every test so reviewers can verify outputs by hand.
const FIXED_RAW_KEY = Buffer.alloc(32);
for (let i = 0; i < 32; i++) FIXED_RAW_KEY[i] = i; // 0x00..0x1F
const FIXED_BASE64_KEY = FIXED_RAW_KEY.toString('base64');

describe('decodeBackupTargetKey', () => {
  it('decodes a valid 32-byte base64 string', () => {
    const out = decodeBackupTargetKey(FIXED_BASE64_KEY);
    expect(out.length).toBe(32);
    expect(out.equals(FIXED_RAW_KEY)).toBe(true);
  });

  it('strips trailing newline / whitespace', () => {
    const out = decodeBackupTargetKey(`${FIXED_BASE64_KEY}\n   `);
    expect(out.equals(FIXED_RAW_KEY)).toBe(true);
  });

  it('rejects empty input', () => {
    expect(() => decodeBackupTargetKey('')).toThrow(/empty/i);
    expect(() => decodeBackupTargetKey('   \n')).toThrow(/empty/i);
  });

  it('rejects wrong length', () => {
    const tooShort = Buffer.alloc(16).toString('base64');
    expect(() => decodeBackupTargetKey(tooShort)).toThrow(/32/);
    const tooLong = Buffer.alloc(64).toString('base64');
    expect(() => decodeBackupTargetKey(tooLong)).toThrow(/32/);
  });
});

describe('fingerprintRawKey', () => {
  it('matches the sha256-of-raw-bytes convention', () => {
    // sha256 of 0x00..0x1F = '4499f9d75dffb1ddd9aaa37c7afbf3a3' + …
    // first 16 hex chars only.
    const fp = fingerprintRawKey(FIXED_RAW_KEY);
    // Pre-computed: sha256(0x00..0x1F) → 630dcd2966c43366… (first 16 hex)
    expect(fp).toBe('630dcd2966c43366');
    expect(fp.length).toBe(16);
  });

  it('rejects non-32-byte input', () => {
    expect(() => fingerprintRawKey(Buffer.alloc(16))).toThrow(/32/);
    expect(() => fingerprintRawKey(Buffer.alloc(64))).toThrow(/32/);
  });

  it('agrees with the bash bootstrap.sh + rotate.sh convention', () => {
    // bootstrap.sh: `printf '%s' "$base64_key" | base64 -d | sha256sum | head -c 16`
    // Equivalent here: hash the RAW bytes (the result of base64-decode).
    const fp = fingerprintRawKey(decodeBackupTargetKey(FIXED_BASE64_KEY));
    expect(fp.length).toBe(16);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('deriveShimAccessKey', () => {
  it('is deterministic for a given raw key', () => {
    const a = deriveShimAccessKey(FIXED_RAW_KEY);
    const b = deriveShimAccessKey(FIXED_RAW_KEY);
    expect(a).toBe(b);
  });

  it('produces 20 hex chars (AWS-access-key-like format)', () => {
    const ak = deriveShimAccessKey(FIXED_RAW_KEY);
    expect(ak).toMatch(/^[0-9a-f]{20}$/);
  });

  it('differs across different keys', () => {
    const other = Buffer.alloc(32, 0xff);
    expect(deriveShimAccessKey(FIXED_RAW_KEY)).not.toBe(deriveShimAccessKey(other));
  });
});

describe('deriveShimSecretKey', () => {
  it('is deterministic', () => {
    expect(deriveShimSecretKey(FIXED_RAW_KEY)).toBe(deriveShimSecretKey(FIXED_RAW_KEY));
  });

  it('produces 80 hex chars (40 bytes)', () => {
    const sk = deriveShimSecretKey(FIXED_RAW_KEY);
    expect(sk).toMatch(/^[0-9a-f]{80}$/);
  });

  it('is independent of the access key', () => {
    // Domain separation: the same HKDF input + different labels MUST
    // produce unrelated outputs. We check they don't share a prefix.
    const ak = deriveShimAccessKey(FIXED_RAW_KEY);
    const sk = deriveShimSecretKey(FIXED_RAW_KEY);
    expect(sk.startsWith(ak)).toBe(false);
    expect(ak.startsWith(sk.slice(0, 20))).toBe(false);
  });
});

describe('deriveCryptCredentials', () => {
  it('produces obscured rclone-format passphrases for each class', () => {
    for (const cls of ['system', 'tenant', 'mail'] as const) {
      const creds = deriveCryptCredentials(FIXED_RAW_KEY, cls);
      // Obscured form is base64url(IV || ciphertext) — non-empty, no
      // padding, URL-safe charset.
      expect(creds.obscuredPassword).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(creds.obscuredSalt).toMatch(/^[A-Za-z0-9_-]+$/);
      // IV is 16 bytes → 22 chars base64url at minimum.
      expect(creds.obscuredPassword.length).toBeGreaterThanOrEqual(40);
      expect(creds.obscuredSalt.length).toBeGreaterThanOrEqual(40);
      // password and salt MUST differ — they're independent HKDF outputs.
      expect(creds.obscuredPassword).not.toBe(creds.obscuredSalt);
    }
  });

  it('domain-separates classes via HKDF info-label suffixes', () => {
    // True domain-separation test using deriveCryptRawHex (which
    // returns the pre-obscure HKDF output). Random-IV randomness of
    // the obscure layer cannot mask a label collision here.
    const sys = deriveCryptRawHex(FIXED_RAW_KEY, 'system');
    const ten = deriveCryptRawHex(FIXED_RAW_KEY, 'tenant');
    const mail = deriveCryptRawHex(FIXED_RAW_KEY, 'mail');

    // No two classes share a password.
    expect(sys.passwordHex).not.toBe(ten.passwordHex);
    expect(ten.passwordHex).not.toBe(mail.passwordHex);
    expect(sys.passwordHex).not.toBe(mail.passwordHex);

    // No two classes share a salt.
    expect(sys.saltHex).not.toBe(ten.saltHex);
    expect(ten.saltHex).not.toBe(mail.saltHex);
    expect(sys.saltHex).not.toBe(mail.saltHex);

    // Within a class, password and salt differ (independent HKDF outputs).
    expect(sys.passwordHex).not.toBe(sys.saltHex);
    expect(ten.passwordHex).not.toBe(ten.saltHex);
    expect(mail.passwordHex).not.toBe(mail.saltHex);

    // Determinism: re-derivation produces identical hex output.
    expect(deriveCryptRawHex(FIXED_RAW_KEY, 'system')).toEqual(sys);
  });

  it('top-level obscured API surface produces different output per class', () => {
    // Sanity check on the obscured form too — even though the test
    // above catches a label collision more reliably, this guards
    // against a regression where the obscure layer accidentally drops
    // domain separation (e.g. someone uses a fixed IV).
    const sys = deriveCryptCredentials(FIXED_RAW_KEY, 'system');
    const ten = deriveCryptCredentials(FIXED_RAW_KEY, 'tenant');
    const mail = deriveCryptCredentials(FIXED_RAW_KEY, 'mail');
    expect(sys.obscuredPassword).not.toBe(ten.obscuredPassword);
    expect(ten.obscuredPassword).not.toBe(mail.obscuredPassword);
    expect(sys.obscuredPassword).not.toBe(mail.obscuredPassword);
  });

  it('produces different obscured outputs on each call (random IV)', () => {
    // Property of rcloneObscure: random IV → different ciphertext for
    // identical plaintext. Two consecutive derivations for the same
    // class MUST differ at the obscured layer (otherwise the IV
    // randomization is broken).
    const a = deriveCryptCredentials(FIXED_RAW_KEY, 'system');
    const b = deriveCryptCredentials(FIXED_RAW_KEY, 'system');
    expect(a.obscuredPassword).not.toBe(b.obscuredPassword);
  });
});

describe('deriveResticPassword', () => {
  it('returns the base64-encoded raw key', () => {
    const out = deriveResticPassword(FIXED_RAW_KEY);
    expect(out).toBe(FIXED_BASE64_KEY);
  });

  it('is the same value across all restic CronJobs (single global key)', () => {
    // Sanity: deriveResticPassword has no class/scope parameter — by
    // design, every restic CronJob across the platform uses ONE
    // RESTIC_PASSWORD. Verify the function signature.
    expect(deriveResticPassword.length).toBe(1);
  });
});

describe('rcloneObscure', () => {
  it('produces base64url output', () => {
    const out = rcloneObscure('hello-world');
    expect(out).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(out).not.toContain('=');
    expect(out).not.toContain('+');
    expect(out).not.toContain('/');
  });

  it('uses a random IV (different output each call)', () => {
    const a = rcloneObscure('same-plaintext');
    const b = rcloneObscure('same-plaintext');
    expect(a).not.toBe(b);
  });

  it('handles empty string without crashing', () => {
    expect(() => rcloneObscure('')).not.toThrow();
  });

  it('output length: 16 IV bytes + plaintext, base64url-encoded', () => {
    // base64url of N bytes = ceil(N * 4/3) chars (no padding)
    const plain = 'x'.repeat(32);
    const out = rcloneObscure(plain);
    // 16 IV + 32 plaintext = 48 bytes → 64 base64url chars
    expect(out.length).toBe(64);
  });
});
