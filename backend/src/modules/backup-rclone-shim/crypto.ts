/**
 * HKDF derivations from the platform-wide BACKUP_TARGET_KEY.
 *
 * See BACKUP_ARCHITECTURE_RFC §13b. ONE 32-byte secret underpins:
 *   - shim_access_key + shim_secret_key  (S3 creds the shim accepts
 *     from local-node clients; HKDF-SHA256 derived so they can be
 *     re-derived deterministically by every consumer without an
 *     extra Secret round-trip)
 *   - crypt_password + crypt_salt        (rclone `crypt` backend's
 *     two passphrases; derived independently per-class to give
 *     domain separation between SYSTEM / TENANT / MAIL buckets)
 *   - restic_password                    (base64 of the raw 32 bytes;
 *     restic accepts any string as passphrase)
 *
 * Deterministic derivation means a fresh cluster restoring from the
 * Tier-1 secrets bundle ONLY needs the bundle (which contains the
 * BACKUP_TARGET_KEY Secret) — every other derivable secret is
 * recomputed at boot.
 *
 * Why HKDF-SHA256 specifically:
 *   - RFC-5869 standard; node:crypto hkdfSync is FIPS-compliant
 *   - Variable-length output via the `length` parameter
 *   - `info` parameter provides domain separation so leaking one
 *     derivation cannot help an attacker recover another
 *
 * Notes on rclone crypt passwords:
 *   - rclone stores passwords in its config in an "obscured" form
 *     (AES-CTR-128 with a fixed key — security-by-obscurity, treated
 *     as plaintext by anyone reading the conf). We produce the
 *     obscured form here so the rendered rclone.conf is directly
 *     usable. See `rcloneObscure()`.
 *   - The crypt backend uses TWO passphrases: `password` (the actual
 *     key material) and `password2` (salt). RFC-5869 with different
 *     `info` strings gives us independent values.
 */

import { createCipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** rclone's fixed obscure key — same one rclone uses for `rclone obscure`.
 *  See rclone source: lib/obscure/obscure.go cryptKey.
 *  This is NOT a secret — it's a deterministic transform so rclone can
 *  read the conf without prompting for an interactive password. We
 *  pre-obscure values here so the rendered config is directly loadable.
 */
// Source: https://github.com/rclone/rclone/blob/master/fs/config/obscure/obscure.go
// Last 16 bytes were previously transcribed incorrectly (f6de27c0c2ce18ce) →
// rclone's reveal produced binary garbage → upstream S3 returned
// SignatureDoesNotMatch on every shim-routed request. Cross-checked against
// `rclone obscure <plaintext>` output: our obscure now round-trips through
// `rclone reveal`. See backend/src/modules/storage-lifecycle/rclone-obscure.ts
// for the same constant + cross-check unit test (rclone-obscure.test.ts).
const RCLONE_OBSCURE_KEY = Buffer.from(
  '9c935b48730a554d6bfd7c63c886a92b' + 'd390198eb8128afbf4de162b8b95f638',
  'hex'
);

/** HKDF labels — domain-separation for each derived secret. Changing
 *  these is a hard breaking change (existing backups become
 *  unreadable). New consumers MUST pick a new label.
 */
const HKDF_LABELS = {
  shimAccessKey: 'platform.phoenix-host.net/backup-rclone-shim/s3-access',
  shimSecretKey: 'platform.phoenix-host.net/backup-rclone-shim/s3-secret',
  cryptPassword: 'platform.phoenix-host.net/backup-rclone-shim/crypt-password',
  cryptSalt: 'platform.phoenix-host.net/backup-rclone-shim/crypt-salt',
} as const;

/** Zero-filled 32-byte salt for HKDF-Extract (matching SHA-256's
 *  HashLen per RFC-5869 §2.2). RFC-5869 §3.1 explicitly permits an
 *  all-zero salt; since BACKUP_TARGET_KEY itself is high-entropy CSPRNG
 *  output the Extract phase collapses to a fast HMAC-SHA256(0, ikm)
 *  and the security properties of the Expand phase are unaffected.
 *  Standard practice.
 */
const HKDF_SALT = Buffer.alloc(32);

// ---------------------------------------------------------------------------
// Decoding helpers
// ---------------------------------------------------------------------------

/**
 * Decode the BACKUP_TARGET_KEY Secret's `key` field (base64-encoded
 * 32 bytes) into the raw 32-byte buffer. Throws if the length is wrong
 * — the rotation script + bootstrap.sh both enforce 32 bytes, and a
 * mismatch indicates Secret corruption.
 */
export function decodeBackupTargetKey(base64Key: string): Buffer {
  // Trim whitespace; the Secret round-trips through k8s `\n`-terminated
  // YAML which can sneak in a newline on misuse.
  const trimmed = base64Key.trim();
  if (trimmed.length === 0) {
    throw new Error('BACKUP_TARGET_KEY is empty');
  }
  let raw: Buffer;
  try {
    raw = Buffer.from(trimmed, 'base64');
  } catch {
    throw new Error('BACKUP_TARGET_KEY is not valid base64');
  }
  if (raw.length !== 32) {
    throw new Error(
      `BACKUP_TARGET_KEY decoded to ${raw.length} bytes; expected 32 (256 bits)`
    );
  }
  return raw;
}

/**
 * sha256(rawKey).substring(0, 16) — the 16-char hex fingerprint
 * used by bootstrap.sh, the rotation CLI, and the status ConfigMap.
 * Convention: hash the RAW 32 bytes (not the base64 string). The
 * three components MUST agree so cross-checks work; this function
 * is the single source of truth.
 */
export function fingerprintRawKey(rawKey: Buffer): string {
  if (rawKey.length !== 32) {
    throw new Error(
      `fingerprintRawKey expects 32 bytes; got ${rawKey.length}`
    );
  }
  return createHash('sha256').update(rawKey).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Per-shim S3 credentials
// ---------------------------------------------------------------------------

/**
 * Derive the shim's local S3 access_key. Static across the cluster;
 * recomputed at every reconcile (always the same value for a given
 * BACKUP_TARGET_KEY). Format: 20 hex chars (matches typical AWS-style
 * access-key length so consumers can't tell it's derived).
 */
export function deriveShimAccessKey(rawKey: Buffer): string {
  const out = hkdfSync('sha256', rawKey, HKDF_SALT, HKDF_LABELS.shimAccessKey, 10);
  // ArrayBuffer in older types — Buffer.from accepts both.
  return Buffer.from(out).toString('hex'); // 20 hex chars
}

/**
 * Derive the shim's local S3 secret_key. 40-byte HKDF output → 80 hex
 * chars (richer than the 40-char AWS-style for our internal endpoint).
 */
export function deriveShimSecretKey(rawKey: Buffer): string {
  const out = hkdfSync('sha256', rawKey, HKDF_SALT, HKDF_LABELS.shimSecretKey, 40);
  return Buffer.from(out).toString('hex'); // 80 hex chars
}

// ---------------------------------------------------------------------------
// Per-class crypt passwords
// ---------------------------------------------------------------------------

/** A class's crypt passphrase + salt, both already in rclone's obscure
 *  format (directly storable in rclone.conf without further
 *  transformation). Per-class domain separation means a leaked SYSTEM
 *  crypt key cannot decrypt TENANT or MAIL data.
 */
export interface CryptCredentials {
  readonly obscuredPassword: string;
  readonly obscuredSalt: string;
}

/**
 * Internal: derive the per-class crypt passphrase + salt as raw hex
 * (BEFORE the rclone-obscure random-IV transform). Exposed so unit
 * tests can verify HKDF domain-separation across classes without
 * being defeated by obscure-IV randomness.
 *
 * Callers should normally use `deriveCryptCredentials` instead — that
 * returns the obscured form directly usable in rclone.conf.
 */
export function deriveCryptRawHex(
  rawKey: Buffer,
  className: 'system' | 'tenant' | 'mail'
): { readonly passwordHex: string; readonly saltHex: string } {
  const passwordRaw = Buffer.from(
    hkdfSync('sha256', rawKey, HKDF_SALT, `${HKDF_LABELS.cryptPassword}/${className}`, 32)
  );
  const saltRaw = Buffer.from(
    hkdfSync('sha256', rawKey, HKDF_SALT, `${HKDF_LABELS.cryptSalt}/${className}`, 32)
  );
  return {
    passwordHex: passwordRaw.toString('hex'),
    saltHex: saltRaw.toString('hex'),
  };
}

/**
 * Derive a SHARED crypt passphrase + salt for the unified shim
 * architecture (R-X16: single [encrypted] crypt remote, no combine).
 *
 * This is the SINGLE crypt key used by the rendered `[encrypted]`
 * section. Per-class keys (deriveCryptCredentials) are retained in
 * code for migration tooling that needs to read older per-class
 * encrypted blobs, but new renders use only this shared key.
 *
 * Trade-off: one shared key vs. three per-class keys. Acceptable
 * because all classes already share the same BACKUP_TARGET_KEY
 * Secret AND share the same upstream credentials (one row in
 * backup_configurations per target). The per-class HKDF derivation
 * was protecting against accidental cross-class config drift in the
 * renderer, not adversarial isolation.
 *
 * Domain-separation label `shared` (NOT one of system/tenant/mail)
 * ensures the shared key is cryptographically distinct from any
 * legacy per-class key — operators can't accidentally read old
 * per-class blobs through the new shared remote.
 */
export function deriveSharedCryptCredentials(rawKey: Buffer): CryptCredentials {
  const passwordRaw = Buffer.from(
    hkdfSync(
      'sha256',
      rawKey,
      HKDF_SALT,
      `${HKDF_LABELS.cryptPassword}/shared`,
      32,
    ),
  );
  const saltRaw = Buffer.from(
    hkdfSync(
      'sha256',
      rawKey,
      HKDF_SALT,
      `${HKDF_LABELS.cryptSalt}/shared`,
      32,
    ),
  );
  return {
    obscuredPassword: rcloneObscure(passwordRaw.toString('hex')),
    obscuredSalt: rcloneObscure(saltRaw.toString('hex')),
  };
}

/**
 * @deprecated Retained for migration tooling that reads legacy per-class
 * encrypted blobs. New renders use {@link deriveSharedCryptCredentials}.
 *
 * Derive the per-class crypt passphrase + salt. `className` is one of
 * 'system' / 'tenant' / 'mail' (lowercase canonical) and is included
 * in the HKDF `info` field so each class gets independent values.
 *
 * Returns the two passphrases in rclone's "obscured" format, ready
 * to drop into rclone.conf as `password = ...` and `password2 = ...`.
 */
export function deriveCryptCredentials(
  rawKey: Buffer,
  className: 'system' | 'tenant' | 'mail'
): CryptCredentials {
  // rclone expects the obscured form to be a base64-of-AES-CTR-128
  // ciphertext. The plaintext is the user's passphrase (any string).
  // We use the hex-encoded raw bytes as the "plaintext" passphrase
  // — high-entropy, predictable length, no special chars.
  const { passwordHex, saltHex } = deriveCryptRawHex(rawKey, className);
  return {
    obscuredPassword: rcloneObscure(passwordHex),
    obscuredSalt: rcloneObscure(saltHex),
  };
}

// ---------------------------------------------------------------------------
// Restic passphrase
// ---------------------------------------------------------------------------

/**
 * Derive the RESTIC_PASSWORD value. Restic accepts any string; we use
 * the base64-encoded raw 32 bytes for maximum compatibility (no
 * special chars that could confuse downstream YAML or env-var
 * handling).
 *
 * NOTE: This is the SAME value for every restic CronJob across the
 * platform — bulwark, crowdsec, monitoring, mail-restic all use one
 * RESTIC_PASSWORD. Per RFC §13b, the global key simplifies DR: ONE
 * Secret restored → every restic repo readable.
 *
 * SECURITY IMPLICATION: this output is the base64 encoding of the
 * raw BACKUP_TARGET_KEY itself — NOT an HKDF-derived sub-key. A
 * leaked RESTIC_PASSWORD env var therefore has the SAME blast
 * radius as a leaked BACKUP_TARGET_KEY (compromise of all platform
 * backup encryption). This is an intentional consequence of the
 * "one key, one DR artefact" design; operators must treat restic
 * CronJob env vars with the same care as the Tier-1 secrets bundle.
 */
export function deriveResticPassword(rawKey: Buffer): string {
  return rawKey.toString('base64');
}

// ---------------------------------------------------------------------------
// rclone obscure
// ---------------------------------------------------------------------------

/**
 * Port of rclone's `rclone obscure` algorithm to TypeScript. Used to
 * pre-obscure crypt + sftp passwords in rendered rclone.conf so the
 * shim doesn't need to invoke the rclone binary at reconcile time.
 *
 * Algorithm (lib/obscure/obscure.go in rclone source):
 *   1. Generate a 16-byte random IV (or zero IV for deterministic
 *      output — here we use random for non-replayability of leaked
 *      configs)
 *   2. AES-128-CTR encrypt the UTF-8 plaintext under a fixed key + IV
 *   3. Output = base64url(IV || ciphertext)
 *
 * The fixed `cryptKey` in rclone source is treated as public — this
 * is NOT cryptographic protection. It's reversible by anyone with
 * the rclone binary; the obscure form just prevents casual shoulder-
 * surfing of plaintext passwords in conf files.
 *
 * We use a fresh random IV per call so two identical plaintexts produce
 * different ciphertexts (no statistical fingerprint in configs).
 */
export function rcloneObscure(plaintext: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv(
    'aes-256-ctr',
    RCLONE_OBSCURE_KEY,
    iv
  );
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  // rclone uses base64.URLEncoding (no padding). Node's base64url variant
  // matches that.
  return Buffer.concat([iv, ciphertext]).toString('base64url');
}
