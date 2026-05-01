import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm, readdir, stat as fsStat, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { BACKUP_META_SCHEMA_VERSION, type BackupMetaV1 } from '@k8s-hosting/api-contracts';
import { LocalHostPathBackupStore, LocalHostPathBackupStore as LocalHostPathBackupStoreImport } from './local-hostpath-backup-store.js';

const VALID_META: BackupMetaV1 = {
  schemaVersion: BACKUP_META_SCHEMA_VERSION,
  backupId: 'bkp-aaaa',
  clientId: '4ec7436d-6159-4bf0-9282-d7e4cc19410b',
  capturedAt: '2026-05-01T10:00:00.000Z',
  platformVersion: '0.3.1',
  initiator: 'admin',
  systemTrigger: null,
  label: null,
  components: { files: { sizeBytes: 5, fileCount: 1, sha256: 'a'.repeat(64) } },
  nodePlacement: null,
  expiresAt: null,
  retentionDays: 30,
  description: null,
};

async function withStore<T>(fn: (store: LocalHostPathBackupStore, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'bundle-store-'));
  try {
    return await fn(new LocalHostPathBackupStore(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('LocalHostPathBackupStore', () => {
  it('reserveBundle creates the four component subdirs', async () => {
    await withStore(async (store, root) => {
      const handle = await store.reserveBundle({ backupId: 'bkp-aaaa', clientId: '4ec7436d-6159-4bf0-9282-d7e4cc19410b' });
      expect(handle.bundleId).toBe('bkp-aaaa');
      const dirs = await readdir(join(root, 'bkp-aaaa', 'components'));
      expect(dirs.sort()).toEqual(['config', 'files', 'mailboxes', 'secrets']);
    });
  });

  it('writeComponent + readComponent round-trip a payload', async () => {
    await withStore(async (store) => {
      const handle = await store.reserveBundle({ backupId: 'bkp-rt', clientId: '4ec7436d-6159-4bf0-9282-d7e4cc19410b' });
      const payload = Buffer.from('hello world');
      await store.writeComponent(handle, 'files', 'archive.tar.gz', Readable.from(payload));
      const stream = await store.readComponent(handle, 'files', 'archive.tar.gz');
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      expect(Buffer.concat(chunks).toString('utf8')).toBe('hello world');
    });
  });

  it('writeComponent uses tmp-then-rename so partial bodies are invisible on crash', async () => {
    await withStore(async (store, root) => {
      const handle = await store.reserveBundle({ backupId: 'bkp-tmp', clientId: '4ec7436d-6159-4bf0-9282-d7e4cc19410b' });
      // Build a stream that errors after some bytes — pipeline must not
      // leave a half-written archive.tar.gz visible.
      const failing = new Readable({
        read() {
          this.push('partial');
          this.destroy(new Error('simulated network drop'));
        },
      });
      await expect(store.writeComponent(handle, 'files', 'archive.tar.gz', failing))
        .rejects.toThrow();
      const finalPath = join(root, 'bkp-tmp', 'components', 'files', 'archive.tar.gz');
      await expect(fsStat(finalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('listArtifacts ignores .tmp and .sha256 sidecars', async () => {
    await withStore(async (store, root) => {
      const handle = await store.reserveBundle({ backupId: 'bkp-list', clientId: '4ec7436d-6159-4bf0-9282-d7e4cc19410b' });
      const dir = join(root, 'bkp-list', 'components', 'mailboxes');
      await writeFile(join(dir, 'a@x.com.mbox.tar.gz'), 'a');
      await writeFile(join(dir, 'a@x.com.mbox.tar.gz.sha256'), 'a'.repeat(64));
      await writeFile(join(dir, 'b@x.com.mbox.tar.gz.tmp'), 'in-flight');
      const refs = await store.listArtifacts(handle, 'mailboxes');
      expect(refs.map((r) => r.name)).toEqual(['a@x.com.mbox.tar.gz']);
    });
  });

  it('putMeta is the commit marker — getMeta succeeds afterwards', async () => {
    await withStore(async (store, root) => {
      const handle = await store.reserveBundle({ backupId: 'bkp-meta', clientId: '4ec7436d-6159-4bf0-9282-d7e4cc19410b' });
      // No meta.json yet → getMeta throws.
      await expect(store.getMeta(handle)).rejects.toThrow();
      const meta = { ...VALID_META, backupId: 'bkp-meta' };
      await store.putMeta(handle, meta);
      const round = await store.getMeta(handle);
      expect(round.backupId).toBe('bkp-meta');
      // meta.json must exist on disk.
      await expect(fsStat(join(root, 'bkp-meta', 'meta.json'))).resolves.toBeDefined();
    });
  });

  it('open returns null for a non-existent bundle', async () => {
    await withStore(async (store) => {
      expect(await store.open('does-not-exist')).toBeNull();
    });
  });

  it('rejects backupIds that resolve outside the root (path traversal)', async () => {
    await withStore(async (store) => {
      await expect(store.open('../etc/passwd')).rejects.toThrow(/path traversal rejected/);
      await expect(store.reserveBundle({ backupId: '../escape', clientId: '4ec7436d-6159-4bf0-9282-d7e4cc19410b' }))
        .rejects.toThrow(/path traversal rejected/);
    });
  });

  it('production wiring: concurrent reserveBundle calls share one ensure-Job', async () => {
    // Spy on the shared ensure-Job — even with 5 concurrent reserveBundle
    // calls, the underlying Job spec should be created exactly once.
    const createCalls: number[] = [];
    const fakeK8s = {
      batch: {
        createNamespacedJob: vi.fn(async () => { createCalls.push(Date.now()); }),
        readNamespacedJob: vi.fn(async () => ({ status: { succeeded: 1 } })),
      },
      core: { listNamespacedPod: vi.fn(async () => ({ items: [] })) },
    } as unknown as Parameters<typeof LocalHostPathBackupStoreImport>[0];
    const root = await mkdtemp(join(tmpdir(), 'bundle-store-mc-'));
    try {
      // Seed the parent dir so the in-pod mkdir succeeds (the Job is mocked).
      const { mkdir: mkdirFs } = await import('node:fs/promises');
      await mkdirFs(join(root, 'sub'), { recursive: true });
      const store = new LocalHostPathBackupStoreImport({
        inPodRoot: join(root, 'sub'),
        hostpathRoot: root,
        mountPath: root,
        k8s: fakeK8s as unknown as never,
      });
      const handles = await Promise.all(
        Array.from({ length: 5 }, (_, i) => store.reserveBundle({
          backupId: `bkp-mc-${i}-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`.slice(0, 64),
          clientId: '4ec7436d-6159-4bf0-9282-d7e4cc19410b',
        })),
      );
      expect(handles).toHaveLength(5);
      // The big assertion: ensure-Job is created exactly once across
      // all five concurrent reserveBundle calls.
      expect(createCalls).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('delete removes the entire bundle dir', async () => {
    await withStore(async (store, root) => {
      const handle = await store.reserveBundle({ backupId: 'bkp-del', clientId: '4ec7436d-6159-4bf0-9282-d7e4cc19410b' });
      await store.writeComponent(handle, 'files', 'archive.tar.gz', Readable.from(Buffer.from('x')));
      await store.delete(handle);
      await expect(fsStat(join(root, 'bkp-del'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('stat returns sha256 from the sidecar when present', async () => {
    await withStore(async (store, root) => {
      const handle = await store.reserveBundle({ backupId: 'bkp-s', clientId: '4ec7436d-6159-4bf0-9282-d7e4cc19410b' });
      await store.writeComponent(handle, 'files', 'archive.tar.gz', Readable.from(Buffer.from('x')));
      const dir = join(root, 'bkp-s', 'components', 'files');
      await writeFile(join(dir, 'archive.tar.gz.sha256'), `${'b'.repeat(64)}  archive.tar.gz\n`);
      const stat = await store.stat(handle, 'files', 'archive.tar.gz');
      expect(stat?.sha256).toBe('b'.repeat(64));
    });
  });
});
