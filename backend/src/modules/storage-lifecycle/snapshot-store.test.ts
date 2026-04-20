import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHostPathStore, getSnapshotStore } from './snapshot-store.js';

describe('LocalHostPathStore', () => {
  it('reservePath is deterministic and namespaced by client', () => {
    const s = new LocalHostPathStore('/var/lib/platform/snapshots');
    expect(s.reservePath('c1', 'snap1')).toBe('c1/snap1.tar.gz');
    // Different client, same snapshot id — paths must differ so reservations
    // from concurrent ops on different clients can't collide.
    expect(s.reservePath('c2', 'snap1')).toBe('c2/snap1.tar.gz');
  });

  it('mountTarget pairs a hostPath volume spec with the /snapshots mount', () => {
    const s = new LocalHostPathStore('/var/lib/platform/snapshots');
    const t = s.mountTarget('c1/snap1.tar.gz');
    expect(t.mountPath).toBe('/snapshots');
    expect(t.relativePath).toBe('c1/snap1.tar.gz');
    expect(t.volumeSpec).toMatchObject({
      name: 'platform-snapshots',
      hostPath: { path: '/var/lib/platform/snapshots', type: 'DirectoryOrCreate' },
    });
  });

  it('stat returns sizeBytes for a real file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snapstore-'));
    try {
      await mkdir(join(root, 'c1'), { recursive: true });
      await writeFile(join(root, 'c1', 's.tar.gz'), Buffer.alloc(1234));
      const s = new LocalHostPathStore(root);
      expect(await s.stat('c1/s.tar.gz')).toEqual({ sizeBytes: 1234 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stat returns null for a missing file (not an error)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snapstore-'));
    try {
      const s = new LocalHostPathStore(root);
      expect(await s.stat('gone/x.tar.gz')).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('delete is idempotent — returns true once, false afterwards', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snapstore-'));
    try {
      await mkdir(join(root, 'c1'), { recursive: true });
      await writeFile(join(root, 'c1', 's.tar.gz'), 'x');
      const s = new LocalHostPathStore(root);
      expect(await s.delete('c1/s.tar.gz')).toBe(true);
      expect(await s.delete('c1/s.tar.gz')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('getSnapshotStore factory', () => {
  it('returns a LocalHostPathStore by default', () => {
    const s = getSnapshotStore({});
    expect(s).toBeInstanceOf(LocalHostPathStore);
  });

  it('honours STORAGE_SNAPSHOT_HOST_ROOT override', () => {
    const s = getSnapshotStore({ STORAGE_SNAPSHOT_HOST_ROOT: '/custom/root' });
    const t = s.mountTarget('x');
    expect((t.volumeSpec as { hostPath?: { path: string } }).hostPath?.path).toBe('/custom/root');
  });

  it('throws on unknown backend name', () => {
    expect(() => getSnapshotStore({ STORAGE_SNAPSHOT_BACKEND: 'wormhole' })).toThrow(/Unknown snapshot backend/);
  });
});
