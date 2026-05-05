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
