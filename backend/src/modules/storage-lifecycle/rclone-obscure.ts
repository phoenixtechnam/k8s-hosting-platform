// rclone-obscure — TypeScript port of `rclone obscure <password>`.
//
// rclone's config-file password format is "obscured" — an AES-CTR
// reversible encoding with a static key. It is NOT real encryption
// (the key is in rclone's source code), but the env-var-config path
// (`RCLONE_CONFIG_REMOTE_PASS=<obscured>`) requires this format —
// passing plaintext makes rclone interpret the bytes as already-
// obscured and decode them to garbage, which is the bug code-review
// flagged as MEDIUM in Phase 4 for CifsStreamingStore.
//
// Algorithm (from rclone source, fs/config/obscure/obscure.go):
//   key = sha256("rclone")  (32 bytes)
//   iv  = 16 random bytes
//   ciphertext = AES-256-CTR(key, iv, utf8(password))
//   obscured = base64url(iv || ciphertext)  // no padding
//
// Reference: https://github.com/rclone/rclone/blob/master/fs/config/obscure/obscure.go
//
// CRITICAL: the key is intentionally public — operators who want REAL
// encryption use rclone's `--password-command` flag. We rely on
// PLATFORM_ENCRYPTION_KEY at the DB layer for real secrecy; this
// function just produces the wire format rclone expects.

import crypto from 'node:crypto';

// rclone's static obscure key (from fs/config/obscure/obscure.go).
// This is NOT a secret — it's published in rclone's source code so
// any rclone install can de-obscure any obscured value. Anyone with
// access to the encrypted Job pod spec could also de-obscure, which
// is why the upstream code-review HIGH finding (plaintext credentials
// in pod spec) remains a deferred hardening item — switching to
// Secret-mounted credentials closes both leaks at once.
//
// Source:
//   var crypt = []byte{0x9c, 0x93, 0x5b, 0x48, 0x73, 0x0a, 0x55, 0x4d,
//                      0x6b, 0xfd, 0x7c, 0x63, 0xc8, 0x86, 0xa9, 0x2b,
//                      0xd3, 0x90, 0x19, 0x8e, 0xb8, 0x12, 0x8a, 0xfb,
//                      0xf6, 0x78, 0x9d, 0xe3, 0x1f, 0xc9, 0x91, 0x6c}
const RCLONE_KEY_HEX = '9c935b48730a554d6bfd7c63c886a92bd390198eb8128afbf6789de31fc9916c';
const KEY = Buffer.from(RCLONE_KEY_HEX, 'hex');
if (KEY.length !== 32) {
  // Sanity check at module load — if rclone ever changes the key,
  // catch it here rather than silently producing wrong output.
  throw new Error(`rclone-obscure: expected 32-byte key, got ${KEY.length}`);
}

/**
 * Produce rclone's obscured form of a password. Output is suitable for
 * `RCLONE_CONFIG_REMOTE_PASS` env var or rclone.conf `pass = ...` line.
 *
 * Note: this is NOT encryption — the key is public. The function exists
 * because rclone refuses plaintext passwords in its config and would
 * otherwise mis-decode them.
 */
export function rcloneObscure(plaintext: string): string {
  if (plaintext === '') return '';
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-ctr', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const combined = Buffer.concat([iv, ciphertext]);
  // rclone uses base64-url (no padding).
  return combined.toString('base64url');
}

/**
 * Inverse — rarely needed (the Job side never reads back its own
 * obscured password), but useful for unit tests + operator debug.
 */
export function rcloneReveal(obscured: string): string {
  if (obscured === '') return '';
  const combined = Buffer.from(obscured, 'base64url');
  if (combined.length < 16) {
    throw new Error(`rclone-obscure: ciphertext too short (${combined.length} bytes)`);
  }
  const iv = combined.subarray(0, 16);
  const ciphertext = combined.subarray(16);
  const decipher = crypto.createDecipheriv('aes-256-ctr', KEY, iv);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
