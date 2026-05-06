/**
 * GDPR data-export wrapper for tenant bundles.
 *
 * After a successful bundle capture (post-meta.json), the orchestrator
 * may invoke `wrapBundleAsDataExport` to produce a single
 * passphrase-encrypted tarball at:
 *
 *   components/export/<backupId>.tar.gz.enc
 *
 * containing every other component artifact + meta.json. The client
 * downloads this file via the data-export download endpoint and
 * decrypts locally with the passphrase they supplied at create time.
 *
 * Why this design:
 *   - The platform NEVER stores the passphrase. It is hashed for
 *     downstream comparison only if we later want a "verify the
 *     passphrase before download" flow; for now it's used once to
 *     encrypt and discarded.
 *   - One artifact = one download. Operators don't have to reason
 *     about per-component download URLs or stitch tarballs back
 *     together.
 *   - AES-256-CBC + PBKDF2 (100k rounds, sha256) matches `openssl enc
 *     -aes-256-cbc -pbkdf2 -iter 100000` so the client can decrypt
 *     with stock openssl on any platform:
 *
 *       openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
 *         -in <backupId>.tar.gz.enc -out <backupId>.tar.gz \
 *         -pass stdin <<< "$PASSPHRASE"
 *
 * Format: matches OpenSSL's "Salted__" envelope:
 *   "Salted__" (8 bytes) || salt (8 bytes) || ciphertext
 * The ciphertext is the AES-256-CBC encryption of the gzipped tar
 * stream, with key+IV derived via PBKDF2(passphrase, salt, 100k,
 * sha256, 48 bytes) split into 32-byte key and 16-byte IV.
 *
 * Ciphertext stays opaque — the platform cannot read its contents
 * without re-deriving the key from the passphrase the client
 * supplied at create time.
 */

import { pbkdf2Sync, createCipheriv, randomBytes } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pack as tarPack } from 'tar-stream';
import type { BackupStore, BundleHandle } from './bundle-store.js';

const PBKDF2_ITERATIONS = 100_000; // matches `openssl enc -iter 100000`
const KEY_BYTES = 32;
const IV_BYTES = 16;
const SALT_BYTES = 8;

export interface WrapBundleArgs {
  readonly store: BackupStore;
  readonly handle: BundleHandle;
  readonly backupId: string;
  /** Plaintext passphrase. Caller MUST NOT log it. */
  readonly passphrase: string;
  /** All component artifacts to bundle into the tarball. */
  readonly components: ReadonlyArray<{ component: 'files' | 'mailboxes' | 'config' | 'secrets'; name: string }>;
}

export interface WrapBundleResult {
  readonly artifactPath: string;
  readonly sizeBytes: number;
}

/**
 * Build a single AES-256-CBC encrypted tar.gz of the bundle dir +
 * meta.json, write it to the BackupStore as
 * `components/export/<backupId>.tar.gz.enc`. Stream-only — no
 * intermediate disk + no whole-file buffering.
 */
export async function wrapBundleAsDataExport(args: WrapBundleArgs): Promise<WrapBundleResult> {
  const { store, handle, backupId, passphrase, components } = args;
  if (!passphrase || passphrase.length < 12) {
    throw new Error('wrapBundleAsDataExport: passphrase must be ≥12 chars');
  }

  // Derive AES key + IV from passphrase + random salt via PBKDF2.
  // Same KDF and parameters as `openssl enc -pbkdf2 -iter 100000`.
  const salt = randomBytes(SALT_BYTES);
  const derived = pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, PBKDF2_ITERATIONS, KEY_BYTES + IV_BYTES, 'sha256');
  const key = derived.subarray(0, KEY_BYTES);
  const iv = derived.subarray(KEY_BYTES, KEY_BYTES + IV_BYTES);

  // Build a tar stream in memory: meta.json + every component artifact.
  // Backed by a Readable so we can pipe through gzip + cipher without
  // materialising the whole bundle in RAM.
  const tar = tarPack();

  // Add meta.json first.
  const meta = await store.getMeta(handle);
  const metaBuf = Buffer.from(JSON.stringify(meta, null, 2), 'utf8');
  tar.entry({ name: 'meta.json', size: metaBuf.length, mtime: new Date(meta.capturedAt) }, metaBuf);

  // Stream each component artifact into the tar. Drives the tar via
  // an awaitable wrapper so back-pressure works.
  // Run in parallel with the encryption pipeline below.
  const tarFeeder = (async () => {
    try {
      for (const c of components) {
        const stat = await store.stat(handle, c.component, c.name);
        if (!stat) continue; // missing artifact (component was skipped)
        const body = await store.readComponent(handle, c.component, c.name);
        const entry = tar.entry({
          name: `components/${c.component}/${c.name}`,
          size: stat.sizeBytes,
          mtime: new Date(),
        });
        await pipeline(body, entry);
      }
      tar.finalize();
    } catch (err) {
      tar.destroy(err as Error);
    }
  })();

  // Cipher: AES-256-CBC. PKCS#7 padding (Node's default).
  const cipher = createCipheriv('aes-256-cbc', key, iv);

  // Build the output: "Salted__" magic + salt + ciphertext, where
  // ciphertext = AES-CBC(gzip(tar)). Prepend the OpenSSL header
  // bytes via a one-shot Transform that emits them before piping
  // the cipher output.
  const header = Buffer.concat([Buffer.from('Salted__', 'ascii'), salt]);
  let headerEmitted = false;
  const headerPrepender = new Transform({
    transform(chunk, _enc, cb) {
      if (!headerEmitted) {
        this.push(header);
        headerEmitted = true;
      }
      cb(null, chunk);
    },
    flush(cb) {
      if (!headerEmitted) {
        this.push(header);
        headerEmitted = true;
      }
      cb();
    },
  });

  // tar -> gzip -> cipher -> headerPrepender -> store.writeComponent
  const gzip = createGzip({ level: 6 });
  // BackupComponentName is constrained to files/mailboxes/config/
  // secrets in the storage layer. The export artifact is written
  // under the 'config' component slot but with a distinctive name
  // `data-export-<backupId>.tar.gz.enc` so it can never collide
  // with the legitimate `db-rows.json.gz` artifact in the same
  // component dir. A Phase-4.x follow-up could promote 'export'
  // to a first-class component name; for now this naming
  // convention is the gate the download endpoint validates against.
  const artifactName = `data-export-${backupId}.tar.gz.enc`;
  const synthComponent = 'config' as const;

  const inputStream = (tar as unknown as Readable).pipe(gzip).pipe(cipher).pipe(headerPrepender);
  const ref = await store.writeComponent(handle, synthComponent, artifactName, inputStream as Readable, {
    contentType: 'application/octet-stream',
  });
  await tarFeeder; // surface tar errors

  return {
    artifactPath: `components/${synthComponent}/${artifactName}`,
    sizeBytes: ref.sizeBytes,
  };
}
