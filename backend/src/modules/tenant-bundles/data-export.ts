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

import { pbkdf2 as pbkdf2Cb, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { createGzip, createGunzip } from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pack as tarPack, extract as tarExtract } from 'tar-stream';
import type { BackupStore, BundleHandle } from './bundle-store.js';

// 100k-iter PBKDF2 takes 50–100 ms — too long to block the Node
// event loop. The async variant runs the work on libuv's threadpool.
const pbkdf2 = promisify(pbkdf2Cb);

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
  // Async (libuv threadpool) so 100k iterations don't stall the
  // event loop while other HTTP requests are in flight.
  const salt = randomBytes(SALT_BYTES);
  const derived = await pbkdf2(Buffer.from(passphrase, 'utf8'), salt, PBKDF2_ITERATIONS, KEY_BYTES + IV_BYTES, 'sha256');
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

// ─── Multi-region export / import ─────────────────────────────────
//
// The wrapper above WRITES the encrypted tarball back to the same
// off-site target (used by the create-time `exportMode: 'data_export'`
// flow). For multi-region export we want a different shape:
//
//   - Operator picks ANY existing bundle and clicks "Export".
//   - Backend produces the same Salted__-envelope tarball but
//     STREAMS it directly to the HTTP reply — no store.write.
//   - Operator downloads, copies to another region, and uploads
//     via the import endpoint.
//
// `streamEncryptedExport` is the shared inner stream builder.
// `decryptImportTarball` is the inverse used by the import endpoint.

export interface StreamExportArgs {
  readonly store: BackupStore;
  readonly handle: BundleHandle;
  /**
   * Optional passphrase. When supplied (≥12 chars) the gzip(tar) is
   * wrapped in an OpenSSL `Salted__` AES-256-CBC envelope. When
   * omitted/empty the function emits plain `tar.gz` so any OS can
   * extract with `tar -xzf` and no key.
   */
  readonly passphrase?: string;
  readonly components: ReadonlyArray<{ component: 'files' | 'mailboxes' | 'config' | 'secrets'; name: string }>;
}

/**
 * Build a Readable that yields gzip(tar(meta.json + every component
 * artifact)). When `passphrase` is supplied, the gzip stream is
 * additionally wrapped in an OpenSSL `Salted__` AES-256-CBC envelope
 * (decryptable with stock `openssl enc -d -aes-256-cbc -pbkdf2`).
 * When omitted, the bytes are plain gzipped tar.
 *
 * Either way the function streams end-to-end — tar is fed
 * incrementally from S3 reads via `store.readComponent`, gzip + AES
 * (when enabled) sit in the pipeline as Transform streams, and the
 * caller pipes the returned Readable to the HTTP reply. No
 * server-side staging.
 *
 * Async because PBKDF2 (100k iterations) runs on libuv's threadpool
 * via the async pbkdf2() helper rather than blocking the event loop.
 */
export async function streamEncryptedExport(args: StreamExportArgs): Promise<Readable> {
  const { store, handle, passphrase, components } = args;
  const encrypt = typeof passphrase === 'string' && passphrase.length > 0;
  // No minimum length: the operator chooses (and may have a strong
  // generated password). Non-empty string is the only requirement.

  const tar = tarPack();

  // Async feeder: meta.json + every component artifact in turn.
  // tar-stream backpressures naturally via the entry stream.
  (async () => {
    try {
      const meta = await store.getMeta(handle);
      const metaBuf = Buffer.from(JSON.stringify(meta, null, 2), 'utf8');
      tar.entry({ name: 'meta.json', size: metaBuf.length, mtime: new Date(meta.capturedAt) }, metaBuf);

      for (const c of components) {
        const stat = await store.stat(handle, c.component, c.name);
        if (!stat) continue;
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

  const gzip = createGzip({ level: 6 });
  // CRITICAL: stream.pipe() does NOT forward errors from src to dest.
  // Without this listener a `tar.destroy(err)` from the IIFE above
  // emits 'error' on `tar`, no one is listening on `tar` (the route
  // handler attaches to the returned `gzipped`/cipher stream), and
  // Node treats it as an uncaughtException — killing the entire
  // platform-api pod. Forward tar errors to gzip so the route's
  // stream.on('error', ...) handler catches them and the pod stays
  // up. Same pattern below for cipher/headerPrepender.
  tar.on('error', (err) => gzip.destroy(err));
  const gzipped = (tar as unknown as Readable).pipe(gzip);

  if (!encrypt) {
    // Plain tar.gz path: no key derivation, no cipher, no header.
    return gzipped;
  }

  // Encrypted path: PBKDF2 → AES-256-CBC, OpenSSL `Salted__` envelope.
  const salt = randomBytes(SALT_BYTES);
  const derived = await pbkdf2(
    Buffer.from(passphrase!, 'utf8'),
    salt,
    PBKDF2_ITERATIONS,
    KEY_BYTES + IV_BYTES,
    'sha256',
  );
  const key = derived.subarray(0, KEY_BYTES);
  const iv = derived.subarray(KEY_BYTES, KEY_BYTES + IV_BYTES);

  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const header = Buffer.concat([Buffer.from('Salted__', 'ascii'), salt]);
  let headerEmitted = false;
  const headerPrepender = new Transform({
    transform(chunk, _enc, cb) {
      if (!headerEmitted) { this.push(header); headerEmitted = true; }
      cb(null, chunk);
    },
    flush(cb) {
      if (!headerEmitted) { this.push(header); headerEmitted = true; }
      cb();
    },
  });

  // Same error-forwarding chain for the cipher path. Without these,
  // an early error in the upstream tar/gzip silently strands the
  // response and would crash the pod on a second occurrence.
  gzipped.on('error', (err) => cipher.destroy(err));
  cipher.on('error', (err) => headerPrepender.destroy(err));
  return gzipped.pipe(cipher).pipe(headerPrepender);
}

export interface ImportEntry {
  /** `meta.json` or `components/<component>/<name>`. */
  readonly path: string;
  readonly buffer: Buffer;
}

/**
 * Inverse of `streamEncryptedExport`: takes a buffered Salted__-
 * envelope tarball + passphrase, returns each tar entry as
 * (path, buffer). The caller then registers a new bundle row +
 * uploads each entry to the local off-site target.
 *
 * Buffered (not streaming) on purpose:
 *   - Bundles are typically <1 GB and the HTTP request body is
 *     already buffered into memory by Fastify multipart.
 *   - The import flow needs to write each artifact to a different
 *     `store.writeComponent` call, which is awkward to interleave
 *     with the inner tar-extract stream. Buffering each entry first
 *     keeps the import code linear.
 */
export async function decryptImportTarball(args: {
  readonly cipherBlob: Buffer;
  readonly passphrase: string;
}): Promise<ReadonlyArray<ImportEntry>> {
  const { cipherBlob, passphrase } = args;
  if (!passphrase || passphrase.length < 12) {
    throw new Error('decryptImportTarball: passphrase must be ≥12 chars');
  }

  // Parse OpenSSL Salted__ header.
  if (cipherBlob.length < 16 || cipherBlob.subarray(0, 8).toString('ascii') !== 'Salted__') {
    throw new Error('decryptImportTarball: not an OpenSSL Salted__ envelope');
  }
  const salt = cipherBlob.subarray(8, 16);
  const ciphertext = cipherBlob.subarray(16);

  const derived = await pbkdf2(Buffer.from(passphrase, 'utf8'), salt, PBKDF2_ITERATIONS, KEY_BYTES + IV_BYTES, 'sha256');
  const key = derived.subarray(0, KEY_BYTES);
  const iv = derived.subarray(KEY_BYTES, KEY_BYTES + IV_BYTES);

  // The cipher blob is already in memory, so do the decipher
  // synchronously (no streaming needed). This avoids the
  // unhandled-rejection class where decipher._flush fires a
  // post-pipeline 'bad decrypt' error after the await has already
  // rejected. Wrong passphrase reliably surfaces as the decipher
  // throwing here.
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new Error(`import-decrypt failed (wrong passphrase or corrupt blob): ${err instanceof Error ? err.message : String(err)}`);
  }

  // Gunzip → tar extract → buffer each entry. These run on the
  // decrypted plaintext so any error here is genuinely a malformed
  // tarball — caller will see the wrapped error from below.
  const gunzip = createGunzip();
  const tarX = tarExtract();
  gunzip.on('error', () => undefined);

  const entries: ImportEntry[] = [];
  const collect = new Promise<void>((resolve, reject) => {
    tarX.on('entry', (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        entries.push({ path: header.name, buffer: Buffer.concat(chunks) });
        next();
      });
      stream.on('error', reject);
      stream.resume();
    });
    tarX.on('finish', () => resolve());
    tarX.on('error', reject);
  });

  try {
    await pipeline(Readable.from(plaintext), gunzip, tarX);
    await collect;
  } catch (err) {
    throw new Error(`import-extract failed (corrupt tarball): ${err instanceof Error ? err.message : String(err)}`);
  }
  return entries;
}

// ─── ZIP export (always plaintext) ───────────────────────────────────
//
// Symmetric to `streamEncryptedExport` but produces a `.zip` instead
// of `tar.gz`. Streams end-to-end:
//
//   for each artifact in bundle:
//     S3 GetObject (Readable) → archiver.append(stream, { name, store: true })
//   archiver.finalize() → reply
//
// **Why no password option on the ZIP path** (revisited 2026-05-08
// after a 524 MB E2E ran the platform-api pod OOM):
//
//   The only practical Node ZIP-encryption library
//   (`archiver-zip-encrypted`) implements WinZip AE-1 with three
//   crippling weaknesses for our use case:
//     1. PBKDF2-HMAC-SHA1 @ **1000 iterations** — ~100× weaker
//        key-stretching than the tar.gz.enc path's 100k iterations.
//     2. Pure-JS AES (`aes-js`) — runs at ~10-50 MB/s instead of
//        node:crypto's ~1 GB/s, AND has unbounded-buffer issues at
//        scale (a 524 MB bundle reliably crashed platform-api).
//     3. ZIP central directory still leaks filenames + per-entry
//        sizes regardless of encryption — same metadata leak as a
//        plain ZIP.
//
//   Operators who want password-protected exports should use the
//   tar.gz.enc variant (`POST /admin/tenant-bundles/:id/export`
//   with a passphrase) — it uses node:crypto's hardware-accelerated
//   AES-256-CBC, 100k PBKDF2 iterations, and encrypts filenames
//   along with content. The ZIP path's value is cross-platform
//   plaintext extraction (Windows Explorer / macOS Archive Utility
//   / `unzip` work without extra tools or a password).
//
// If we ever genuinely need password-protected ZIP we can implement
// a native WinZip AE-2 encoder against node:crypto (~100 lines) —
// out of scope for this commit.

export interface StreamZipExportArgs {
  readonly store: BackupStore;
  readonly handle: BundleHandle;
  readonly components: ReadonlyArray<{ component: 'files' | 'mailboxes' | 'config' | 'secrets'; name: string }>;
}

/**
 * Build a Readable that yields a plaintext ZIP archive of meta.json
 * + every component artifact. The ZIP itself is unencrypted; the
 * `secrets` component artifact stays inner-encrypted with the source
 * region's OIDC_ENCRYPTION_KEY (AES-256-GCM) regardless.
 *
 * Async because we lazy-import `archiver` (heavyweight; not loaded
 * on cold paths that don't export).
 */
export async function streamZipExport(args: StreamZipExportArgs): Promise<Readable> {
  const { store, handle, components } = args;

  // archiver is CommonJS; tsconfig esModuleInterop is on, so the
  // default-export form works.
  const { default: archiverFactory } = await import('archiver');

  // Per-entry `store: true` (compression method 0, no zlib framing)
  // skips recompression — every component artifact we ship is already
  // gzip-compressed.
  const archiveRaw = (archiverFactory as unknown as (format: string, opts: Record<string, unknown>) => unknown)('zip', {});

  // Defensive runtime guard against an unexpected archiver return
  // shape; if a future version stops being a Readable, Fastify's
  // `reply.send` would happily forward it and the download would
  // corrupt silently.
  if (
    !archiveRaw
    || typeof (archiveRaw as { append?: unknown }).append !== 'function'
    || typeof (archiveRaw as { finalize?: unknown }).finalize !== 'function'
    || typeof (archiveRaw as { pipe?: unknown }).pipe !== 'function'
    || typeof (archiveRaw as { on?: unknown }).on !== 'function'
  ) {
    throw new Error('streamZipExport: archiver returned an unexpected object shape (not a Readable archive)');
  }
  const archive = archiveRaw as NodeJS.ReadableStream & {
    append: (src: Readable | Buffer | string, opts: { name: string; date?: Date; store?: boolean }) => void;
    finalize: () => Promise<void>;
    on: (event: string, fn: (err: Error) => void) => void;
    destroy: (err?: Error) => void;
  };

  archive.on('error', (err) => {
    archive.destroy(err);
  });

  // Async feeder: meta.json + every component artifact. Mirrors the
  // tar feeder shape; same backpressure properties.
  (async () => {
    try {
      const meta = await store.getMeta(handle);
      const metaBuf = Buffer.from(JSON.stringify(meta, null, 2), 'utf8');
      archive.append(metaBuf, { name: 'meta.json', date: new Date(meta.capturedAt), store: true });

      for (const c of components) {
        const stat = await store.stat(handle, c.component, c.name);
        if (!stat) continue;
        const body = await store.readComponent(handle, c.component, c.name);
        archive.append(body, { name: `components/${c.component}/${c.name}`, date: new Date(), store: true });
      }
      await archive.finalize();
    } catch (err) {
      archive.destroy(err as Error);
    }
  })();

  // archive is a Readable by archiver's contract (verified at runtime
  // above). Fastify's reply.send() pipes it with proper error handling.
  return archive as unknown as Readable;
}
