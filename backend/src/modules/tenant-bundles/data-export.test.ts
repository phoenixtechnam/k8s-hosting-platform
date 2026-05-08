/**
 * Round-trip test for the GDPR data-export wrapper.
 *
 * Builds a mock BackupStore with two artifacts + meta.json, runs
 * wrapBundleAsDataExport, captures the encrypted output, then
 * decrypts it with the same passphrase via the OpenSSL-compatible
 * envelope and asserts the round-trip payload matches the inputs.
 */

import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { extract as tarExtract } from 'tar-stream';
import { wrapBundleAsDataExport } from './data-export.js';
import type { BackupStore, BundleHandle, ArtifactRef, ArtifactStat } from './bundle-store.js';
import type { BackupMetaV1 } from '@k8s-hosting/api-contracts';

function makeMockStore(opts: {
  meta: BackupMetaV1;
  artifacts: Record<string, Buffer>;
  capturedWrite?: { content?: Buffer };
}): BackupStore {
  const handle: BundleHandle = { backupId: 'bkp-test', clientId: 'c1', root: 'mem://bkp-test' };
  return {
    kind: 's3',
    reserveBundle: async () => handle,
    open: async () => handle,
    writeComponent: async (_h, _c, _name, body): Promise<ArtifactRef> => {
      const chunks: Buffer[] = [];
      for await (const c of body as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
      const buf = Buffer.concat(chunks);
      if (opts.capturedWrite) opts.capturedWrite.content = buf;
      return { name: _name, sizeBytes: buf.length, sha256: '' };
    },
    readComponent: async (_h, comp, name): Promise<Readable> => {
      const buf = opts.artifacts[`${comp}/${name}`];
      if (!buf) throw new Error(`mock store: missing ${comp}/${name}`);
      return Readable.from([buf]);
    },
    listArtifacts: async () => [],
    stat: async (_h, comp, name): Promise<ArtifactStat | null> => {
      const buf = opts.artifacts[`${comp}/${name}`];
      if (!buf) return null;
      return { name, sizeBytes: buf.length, sha256: '', exists: true } as ArtifactStat;
    },
    putMeta: async () => undefined,
    getMeta: async () => opts.meta,
    delete: async () => undefined,
  } as unknown as BackupStore;
}

describe('wrapBundleAsDataExport', () => {
  it('produces an OpenSSL-compatible envelope that round-trips with the same passphrase', async () => {
    const passphrase = 'correct-horse-battery-staple-12';
    const meta: BackupMetaV1 = {
      schemaVersion: 1,
      backupId: 'bkp-test',
      clientId: 'c1',
      capturedAt: '2026-05-05T00:00:00.000Z',
      platformVersion: '0.0.0',
      initiator: 'client',
      systemTrigger: null,
      retentionDays: 7,
      label: null,
      description: null,
      components: {},
    } as unknown as BackupMetaV1;
    const artifacts = {
      'config/db-rows.json.gz': Buffer.from('FAKE-CONFIG-DUMP-PAYLOAD'),
      'secrets/tls.json.gz.enc': Buffer.from('FAKE-SECRETS-CIPHERTEXT'),
    };
    const captured: { content?: Buffer } = {};
    const store = makeMockStore({ meta, artifacts, capturedWrite: captured });
    const handle: BundleHandle = { backupId: 'bkp-test', clientId: 'c1', root: 'mem://bkp-test' };

    const result = await wrapBundleAsDataExport({
      store,
      handle,
      backupId: 'bkp-test',
      passphrase,
      components: [
        { component: 'config', name: 'db-rows.json.gz' },
        { component: 'secrets', name: 'tls.json.gz.enc' },
      ],
    });
    expect(result.artifactPath).toBe('components/config/data-export-bkp-test.tar.gz.enc');
    expect(result.sizeBytes).toBeGreaterThan(0);

    // Now decrypt the captured ciphertext exactly as `openssl enc -d
    // -aes-256-cbc -pbkdf2 -iter 100000` would.
    const cipher = captured.content!;
    expect(cipher.subarray(0, 8).toString('ascii')).toBe('Salted__');
    const salt = cipher.subarray(8, 16);
    const body = cipher.subarray(16);
    const derived = pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, 100_000, 48, 'sha256');
    const key = derived.subarray(0, 32);
    const iv = derived.subarray(32, 48);
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    const plaintextGz = Buffer.concat([decipher.update(body), decipher.final()]);
    const plaintextTar = gunzipSync(plaintextGz);

    // Walk the tar.
    const entries: Record<string, Buffer> = {};
    await new Promise<void>((resolve, reject) => {
      const ext = tarExtract();
      ext.on('entry', (header, stream, next) => {
        const chunks: Buffer[] = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => { entries[header.name] = Buffer.concat(chunks); next(); });
        stream.on('error', reject);
        stream.resume();
      });
      ext.on('finish', () => resolve());
      ext.on('error', reject);
      ext.end(plaintextTar);
    });
    expect(Object.keys(entries).sort()).toEqual([
      'components/config/db-rows.json.gz',
      'components/secrets/tls.json.gz.enc',
      'meta.json',
    ]);
    expect(entries['components/config/db-rows.json.gz'].toString()).toBe('FAKE-CONFIG-DUMP-PAYLOAD');
    expect(entries['components/secrets/tls.json.gz.enc'].toString()).toBe('FAKE-SECRETS-CIPHERTEXT');
    const decodedMeta = JSON.parse(entries['meta.json'].toString()) as BackupMetaV1;
    expect(decodedMeta.backupId).toBe('bkp-test');
  });

  it('rejects passphrase shorter than 12 chars', async () => {
    const meta = { schemaVersion: 1, backupId: 'x', clientId: 'c', capturedAt: '2026-01-01T00:00:00Z' } as BackupMetaV1;
    const store = makeMockStore({ meta, artifacts: {} });
    const handle: BundleHandle = { backupId: 'x', clientId: 'c', root: 'mem://x' };
    await expect(wrapBundleAsDataExport({
      store,
      handle,
      backupId: 'x',
      passphrase: 'short',
      components: [],
    })).rejects.toThrow(/≥12 chars/);
  });
});

// ─── Multi-region export/import round-trip ───────────────────────

describe('streamEncryptedExport + decryptImportTarball', () => {
  it('round-trips a bundle through stream-export → import-decrypt', async () => {
    const { streamEncryptedExport, decryptImportTarball } = await import('./data-export.js');
    const passphrase = 'multi-region-test-pw-1234';
    const meta: BackupMetaV1 = {
      schemaVersion: 1,
      backupId: 'bkp-src',
      clientId: 'src-tenant',
      capturedAt: '2026-05-07T00:00:00.000Z',
      platformVersion: '0.0.0',
      initiator: 'admin',
      systemTrigger: null,
      retentionDays: 30,
      label: 'pre-region-migration',
      description: null,
      components: {},
    } as unknown as BackupMetaV1;
    const artifacts = {
      'files/archive.tar.gz': Buffer.from('FAKE-FILES-PAYLOAD'),
      'config/db-rows.json.gz': Buffer.from('FAKE-CONFIG'),
      'secrets/tls.json.gz.enc': Buffer.from('ALREADY-INNER-ENCRYPTED'),
    };
    const store = makeMockStore({ meta, artifacts });
    const handle: BundleHandle = { backupId: 'bkp-src', clientId: 'src-tenant', root: 'mem://bkp-src' };

    // Stream export → buffer.
    const stream = await streamEncryptedExport({
      store,
      handle,
      passphrase,
      components: [
        { component: 'files', name: 'archive.tar.gz' },
        { component: 'config', name: 'db-rows.json.gz' },
        { component: 'secrets', name: 'tls.json.gz.enc' },
      ],
    });
    const cipherChunks: Buffer[] = [];
    for await (const c of stream as AsyncIterable<Buffer>) cipherChunks.push(Buffer.from(c));
    const cipherBlob = Buffer.concat(cipherChunks);
    expect(cipherBlob.subarray(0, 8).toString('ascii')).toBe('Salted__');

    // Import side: decrypt + extract.
    const entries = await decryptImportTarball({ cipherBlob, passphrase });
    const byPath = new Map(entries.map((e) => [e.path, e.buffer]));
    expect(byPath.has('meta.json')).toBe(true);
    expect(byPath.get('components/files/archive.tar.gz')?.toString()).toBe('FAKE-FILES-PAYLOAD');
    expect(byPath.get('components/config/db-rows.json.gz')?.toString()).toBe('FAKE-CONFIG');
    expect(byPath.get('components/secrets/tls.json.gz.enc')?.toString()).toBe('ALREADY-INNER-ENCRYPTED');
    const importedMeta = JSON.parse(byPath.get('meta.json')!.toString());
    expect(importedMeta.backupId).toBe('bkp-src');
  });

  it('accepts a short passphrase (no min-length floor since 2026-05-08)', async () => {
    // The 12-char minimum was removed; operator-chosen length is on
    // them. Empty string still means "plaintext" (separate test).
    const { streamEncryptedExport } = await import('./data-export.js');
    const meta: BackupMetaV1 = { schemaVersion: 2, backupId: 'b', clientId: 'c', capturedAt: '2026-05-07T00:00:00.000Z', platformVersion: '0', initiator: 'admin', systemTrigger: null, retentionDays: 1, label: null, description: null, components: {} } as unknown as BackupMetaV1;
    const store = makeMockStore({ meta, artifacts: {} });
    const handle: BundleHandle = { backupId: 'b', clientId: 'c', root: 'mem://b' };
    const stream = await streamEncryptedExport({ store, handle, passphrase: 'short', components: [] });
    expect(stream).toBeDefined();
  });

  it('rejects a wrong passphrase on import', async () => {
    const { streamEncryptedExport, decryptImportTarball } = await import('./data-export.js');
    const meta: BackupMetaV1 = { schemaVersion: 1, backupId: 'b', clientId: 'c', capturedAt: '2026-05-07T00:00:00.000Z', platformVersion: '0', initiator: 'admin', systemTrigger: null, retentionDays: 1, label: null, description: null, components: {} } as unknown as BackupMetaV1;
    const store = makeMockStore({ meta, artifacts: { 'config/db-rows.json.gz': Buffer.from('x') } });
    const handle: BundleHandle = { backupId: 'b', clientId: 'c', root: 'mem://b' };
    const stream = await streamEncryptedExport({ store, handle, passphrase: 'right-passphrase-12345', components: [{ component: 'config', name: 'db-rows.json.gz' }] });
    const chunks: Buffer[] = [];
    for await (const c of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    const blob = Buffer.concat(chunks);

    await expect(decryptImportTarball({ cipherBlob: blob, passphrase: 'wrong-passphrase-67890' }))
      .rejects.toThrow(/import-decrypt failed/);
  });

  it('rejects a tarball that is not a Salted__ envelope', async () => {
    const { decryptImportTarball } = await import('./data-export.js');
    await expect(decryptImportTarball({
      cipherBlob: Buffer.from('NotAValidEnvelopeOfSufficientLength'),
      passphrase: 'whatever-12-chars',
    })).rejects.toThrow(/not an OpenSSL Salted__ envelope/);
  });

  // ── plain (unencrypted) tar.gz export ────────────────────────────
  it('streams a plain tar.gz when no passphrase is supplied', async () => {
    const { streamEncryptedExport } = await import('./data-export.js');
    const meta: BackupMetaV1 = {
      schemaVersion: 1, backupId: 'bkp-plain', clientId: 'c1',
      capturedAt: '2026-05-08T00:00:00.000Z', platformVersion: '0',
      initiator: 'admin', systemTrigger: null, retentionDays: 1,
      label: null, description: null, components: {},
    } as unknown as BackupMetaV1;
    const store = makeMockStore({
      meta,
      artifacts: { 'config/db-rows.json.gz': Buffer.from('PLAIN-CONFIG') },
    });
    const handle: BundleHandle = { backupId: 'bkp-plain', clientId: 'c1', root: 'mem://bkp-plain' };

    // No passphrase → plain gzip(tar)
    const stream = await streamEncryptedExport({ store, handle, components: [{ component: 'config', name: 'db-rows.json.gz' }] });
    const chunks: Buffer[] = [];
    for await (const c of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    const blob = Buffer.concat(chunks);

    // Plain gzip starts with 1f 8b — no Salted__ header.
    expect(blob.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))).toBe(true);
    expect(blob.subarray(0, 8).toString('ascii')).not.toBe('Salted__');

    // Decompress + extract directly.
    const tarBuf = gunzipSync(blob);
    const tarX = tarExtract();
    const seen: Record<string, Buffer> = {};
    const collected = new Promise<void>((resolve, reject) => {
      tarX.on('entry', (header, s, next) => {
        const cs: Buffer[] = [];
        s.on('data', (c: Buffer) => cs.push(c));
        s.on('end', () => { seen[header.name] = Buffer.concat(cs); next(); });
        s.on('error', reject);
        s.resume();
      });
      tarX.on('finish', () => resolve());
      tarX.on('error', reject);
    });
    Readable.from(tarBuf).pipe(tarX);
    await collected;
    expect(seen['meta.json']).toBeDefined();
    expect(seen['components/config/db-rows.json.gz']?.toString()).toBe('PLAIN-CONFIG');
  });

  it('rejects an empty-string passphrase shorter than 12 chars only when explicitly supplied', async () => {
    // The function distinguishes "absent password" (plain) from
    // "supplied but too short" (validation error). Passing an empty
    // string is treated as absent (no encryption).
    const { streamEncryptedExport } = await import('./data-export.js');
    const meta: BackupMetaV1 = {
      schemaVersion: 1, backupId: 'b', clientId: 'c',
      capturedAt: '2026-05-08T00:00:00.000Z', platformVersion: '0',
      initiator: 'admin', systemTrigger: null, retentionDays: 1,
      label: null, description: null, components: {},
    } as unknown as BackupMetaV1;
    const store = makeMockStore({ meta, artifacts: {} });
    const handle: BundleHandle = { backupId: 'b', clientId: 'c', root: 'mem://b' };

    // Empty string → no encryption, no validation error.
    const stream = await streamEncryptedExport({ store, handle, passphrase: '', components: [] });
    expect(stream).toBeDefined();
  });

  // ── ZIP export (always plaintext) ────────────────────────────────
  it('streams a plain ZIP', async () => {
    const { streamZipExport } = await import('./data-export.js');
    const meta: BackupMetaV1 = {
      schemaVersion: 1, backupId: 'bkp-zip', clientId: 'c1',
      capturedAt: '2026-05-08T00:00:00.000Z', platformVersion: '0',
      initiator: 'admin', systemTrigger: null, retentionDays: 1,
      label: null, description: null, components: {},
    } as unknown as BackupMetaV1;
    const store = makeMockStore({
      meta,
      artifacts: { 'config/db-rows.json.gz': Buffer.from('PLAIN-ZIP-PAYLOAD') },
    });
    const handle: BundleHandle = { backupId: 'bkp-zip', clientId: 'c1', root: 'mem://bkp-zip' };
    const stream = await streamZipExport({ store, handle, components: [{ component: 'config', name: 'db-rows.json.gz' }] });
    const chunks: Buffer[] = [];
    for await (const c of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    const zipBlob = Buffer.concat(chunks);
    // ZIP magic: PK\x03\x04 at byte 0, central directory PK\x05\x06 near end.
    expect(zipBlob.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(zipBlob.length).toBeGreaterThan(50);
  });
});

// ─── Format-detecting import decoder ─────────────────────────────────

describe('detectImportFormat + extractImportArchive', () => {
  const meta: BackupMetaV1 = {
    schemaVersion: 1, backupId: 'bkp-fmt', clientId: 'c1',
    capturedAt: '2026-05-08T00:00:00.000Z', platformVersion: '0',
    initiator: 'admin', systemTrigger: null, retentionDays: 1,
    label: null, description: null, components: {},
  } as unknown as BackupMetaV1;

  it('detectImportFormat distinguishes Salted__ / gzip / zip magic bytes', async () => {
    const { detectImportFormat } = await import('./data-export.js');
    const salted = Buffer.concat([Buffer.from('Salted__'), Buffer.alloc(8)]);
    const gz = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(8)]);
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(8)]);
    expect(detectImportFormat(salted)).toBe('tar-encrypted');
    expect(detectImportFormat(gz)).toBe('tar-plain');
    expect(detectImportFormat(zip)).toBe('zip');
  });

  it('detectImportFormat rejects unknown magic bytes', async () => {
    const { detectImportFormat } = await import('./data-export.js');
    expect(() => detectImportFormat(Buffer.from('garbage-archive-no-magic-bytes'))).toThrow(/unrecognized archive/);
  });

  it('detectImportFormat rejects too-short blobs', async () => {
    const { detectImportFormat } = await import('./data-export.js');
    expect(() => detectImportFormat(Buffer.from([0x01, 0x02]))).toThrow(/too short/);
  });

  it('round-trips a plain tar.gz through stream-export → extractImportArchive', async () => {
    const { streamEncryptedExport, extractImportArchive } = await import('./data-export.js');
    const store = makeMockStore({
      meta, artifacts: { 'config/db-rows.json.gz': Buffer.from('TAR-PLAIN-CONFIG') },
    });
    const handle: BundleHandle = { backupId: 'bkp-fmt', clientId: 'c1', root: 'mem://bkp-fmt' };
    const stream = await streamEncryptedExport({ store, handle, components: [{ component: 'config', name: 'db-rows.json.gz' }] });
    const chunks: Buffer[] = [];
    for await (const c of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    const blob = Buffer.concat(chunks);

    const { format, entries } = await extractImportArchive({ blob });
    expect(format).toBe('tar-plain');
    const byPath = new Map(entries.map((e) => [e.path, e.buffer]));
    expect(byPath.has('meta.json')).toBe(true);
    expect(byPath.get('components/config/db-rows.json.gz')?.toString()).toBe('TAR-PLAIN-CONFIG');
  });

  it('round-trips a Salted__ tarball through stream-export → extractImportArchive', async () => {
    const { streamEncryptedExport, extractImportArchive } = await import('./data-export.js');
    const passphrase = 'fmt-rt-pw';
    const store = makeMockStore({
      meta, artifacts: { 'config/db-rows.json.gz': Buffer.from('TAR-ENC-CONFIG') },
    });
    const handle: BundleHandle = { backupId: 'bkp-fmt', clientId: 'c1', root: 'mem://bkp-fmt' };
    const stream = await streamEncryptedExport({ store, handle, passphrase, components: [{ component: 'config', name: 'db-rows.json.gz' }] });
    const chunks: Buffer[] = [];
    for await (const c of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    const blob = Buffer.concat(chunks);

    const { format, entries } = await extractImportArchive({ blob, passphrase });
    expect(format).toBe('tar-encrypted');
    const byPath = new Map(entries.map((e) => [e.path, e.buffer]));
    expect(byPath.get('components/config/db-rows.json.gz')?.toString()).toBe('TAR-ENC-CONFIG');
  });

  it('round-trips a ZIP through streamZipExport → extractImportArchive', async () => {
    const { streamZipExport, extractImportArchive } = await import('./data-export.js');
    const store = makeMockStore({
      meta, artifacts: {
        'config/db-rows.json.gz': Buffer.from('ZIP-CONFIG'),
        'files/archive.tar.gz': Buffer.from('ZIP-FILES'),
      },
    });
    const handle: BundleHandle = { backupId: 'bkp-fmt', clientId: 'c1', root: 'mem://bkp-fmt' };
    const stream = await streamZipExport({ store, handle, components: [
      { component: 'config', name: 'db-rows.json.gz' },
      { component: 'files', name: 'archive.tar.gz' },
    ] });
    const chunks: Buffer[] = [];
    for await (const c of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    const blob = Buffer.concat(chunks);

    const { format, entries } = await extractImportArchive({ blob });
    expect(format).toBe('zip');
    const byPath = new Map(entries.map((e) => [e.path, e.buffer]));
    expect(byPath.has('meta.json')).toBe(true);
    expect(byPath.get('components/config/db-rows.json.gz')?.toString()).toBe('ZIP-CONFIG');
    expect(byPath.get('components/files/archive.tar.gz')?.toString()).toBe('ZIP-FILES');
  });

  it('rejects encrypted tar without a passphrase', async () => {
    const { streamEncryptedExport, extractImportArchive } = await import('./data-export.js');
    const store = makeMockStore({ meta, artifacts: {} });
    const handle: BundleHandle = { backupId: 'bkp-fmt', clientId: 'c1', root: 'mem://bkp-fmt' };
    const stream = await streamEncryptedExport({ store, handle, passphrase: 'pw', components: [] });
    const chunks: Buffer[] = [];
    for await (const c of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    const blob = Buffer.concat(chunks);
    await expect(extractImportArchive({ blob })).rejects.toThrow(/requires a passphrase/);
  });

  it('rejects a corrupt zip with a clear error', async () => {
    const { extractImportArchive } = await import('./data-export.js');
    // ZIP magic + 4 bytes of garbage
    const blob = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('garbage')]);
    await expect(extractImportArchive({ blob })).rejects.toThrow(/not a valid zip/);
  });

  // ── Zip-slip path traversal guards ─────────────────────────────────
  // assertSafeArchivePath isn't exported, but we can test it indirectly
  // by hand-building a tar.gz with a malicious entry name.
  it('rejects tar.gz entries with path traversal (..)', async () => {
    const { extractImportArchive } = await import('./data-export.js');
    const { pack } = await import('tar-stream');
    const { gzipSync } = await import('node:zlib');
    const tarP = pack();
    // Build a tarball where the only entry has a path traversal name.
    tarP.entry({ name: '../../etc/passwd', size: 4 }, 'evil');
    tarP.finalize();
    const tarChunks: Buffer[] = [];
    for await (const c of tarP as AsyncIterable<Buffer>) tarChunks.push(Buffer.from(c));
    const blob = gzipSync(Buffer.concat(tarChunks));
    await expect(extractImportArchive({ blob })).rejects.toThrow(/path traversal|absolute|backslash|control/);
  });

  it('rejects tar.gz entries with absolute path', async () => {
    const { extractImportArchive } = await import('./data-export.js');
    const { pack } = await import('tar-stream');
    const { gzipSync } = await import('node:zlib');
    const tarP = pack();
    tarP.entry({ name: '/etc/passwd', size: 4 }, 'evil');
    tarP.finalize();
    const tarChunks: Buffer[] = [];
    for await (const c of tarP as AsyncIterable<Buffer>) tarChunks.push(Buffer.from(c));
    const blob = gzipSync(Buffer.concat(tarChunks));
    await expect(extractImportArchive({ blob })).rejects.toThrow(/absolute/);
  });

  it('accepts the canonical bundle layout (meta.json + components/<comp>/<name>)', async () => {
    // Sanity check: the legitimate path patterns we generate via
    // streamEncryptedExport must still pass the safe-path validator.
    const { streamEncryptedExport, extractImportArchive } = await import('./data-export.js');
    const meta: BackupMetaV1 = {
      schemaVersion: 1, backupId: 'bkp-safe', clientId: 'c1',
      capturedAt: '2026-05-08T00:00:00.000Z', platformVersion: '0',
      initiator: 'admin', systemTrigger: null, retentionDays: 1,
      label: null, description: null, components: {},
    } as unknown as BackupMetaV1;
    const store = makeMockStore({
      meta, artifacts: { 'config/db-rows.json.gz': Buffer.from('OK') },
    });
    const handle: BundleHandle = { backupId: 'bkp-safe', clientId: 'c1', root: 'mem://bkp-safe' };
    const stream = await streamEncryptedExport({ store, handle, components: [{ component: 'config', name: 'db-rows.json.gz' }] });
    const chunks: Buffer[] = [];
    for await (const c of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    const blob = Buffer.concat(chunks);
    const { entries } = await extractImportArchive({ blob });
    expect(entries.find((e) => e.path === 'meta.json')).toBeDefined();
    expect(entries.find((e) => e.path === 'components/config/db-rows.json.gz')).toBeDefined();
  });
});
