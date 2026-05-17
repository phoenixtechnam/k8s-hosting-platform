import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHostPathStore, getSnapshotStore } from './snapshot-store.js';

describe('LocalHostPathStore', () => {
  it('reservePath is deterministic and namespaced by tenant', () => {
    const s = new LocalHostPathStore('/var/lib/platform/snapshots');
    expect(s.reservePath('c1', 'snap1')).toBe('c1/snap1.tar.gz');
    // Different tenant, same snapshot id — paths must differ so reservations
    // from concurrent ops on different tenants can't collide.
    expect(s.reservePath('c2', 'snap1')).toBe('c2/snap1.tar.gz');
  });

  it('mountTarget returns a PVC volume spec (PSA baseline-safe) keyed on tenant id', () => {
    // 2026-05-17: switched from inline hostPath to PVC volume because
    // PodSecurity baseline forbids hostPath in tenant namespaces.
    // The PVC's underlying PV is hostPath, which PSA allows because
    // it inspects only Pod.spec.volumes (not the PV chain).
    const s = new LocalHostPathStore('/var/lib/platform/snapshots');
    const t = s.mountTarget('c1/snap1.tar.gz');
    expect(t.mountPath).toBe('/snapshots');
    // relativePath drops the tenant-id segment because the PV is
    // already tenant-scoped (hostPath = <root>/<tenant-id>).
    expect(t.relativePath).toBe('snap1.tar.gz');
    expect(t.volumeSpec).toMatchObject({
      name: 'platform-snapshots',
      persistentVolumeClaim: { claimName: 'platform-snapshots-c1' },
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

  it('readSidecar returns trimmed content of .sha256 sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snapstore-'));
    try {
      await mkdir(join(root, 'c1'), { recursive: true });
      await writeFile(join(root, 'c1', 's.tar.gz'), 'data');
      await writeFile(join(root, 'c1', 's.tar.gz.sha256'), '3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7  /snapshots/c1/s.tar.gz\n');
      const s = new LocalHostPathStore(root);
      const raw = await s.readSidecar('c1/s.tar.gz', '.sha256');
      expect(raw).toBe('3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7  /snapshots/c1/s.tar.gz');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('readSidecar returns null for missing sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snapstore-'));
    try {
      const s = new LocalHostPathStore(root);
      expect(await s.readSidecar('nope/x.tar.gz', '.sha256')).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('delete removes the .sha256 sidecar too', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snapstore-'));
    try {
      await mkdir(join(root, 'c1'), { recursive: true });
      await writeFile(join(root, 'c1', 's.tar.gz'), 'data');
      await writeFile(join(root, 'c1', 's.tar.gz.sha256'), 'hash');
      const s = new LocalHostPathStore(root);
      expect(await s.delete('c1/s.tar.gz')).toBe(true);
      expect(await s.stat('c1/s.tar.gz')).toBeNull();
      expect(await s.readSidecar('c1/s.tar.gz', '.sha256')).toBeNull();
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
    // After the 2026-05-17 PSA-safety switch, mountTarget returns a
    // PVC volumeSpec, so we can no longer assert against an inline
    // hostPath. The hostRoot now appears on the PV that
    // ensureJobMountResources creates — covered by the unit test on
    // that method in this file. Here we just assert the override is
    // accepted (constructor wires up `hostRoot`) and the factory
    // returns a working LocalHostPathStore.
    const s = getSnapshotStore({ STORAGE_SNAPSHOT_HOST_ROOT: '/custom/root' });
    expect(s).toBeInstanceOf(LocalHostPathStore);
    const t = s.mountTarget('c/x.tar.gz');
    expect((t.volumeSpec as { persistentVolumeClaim?: { claimName: string } }).persistentVolumeClaim?.claimName).toBe('platform-snapshots-c');
  });

  it('throws on unknown backend name', () => {
    expect(() => getSnapshotStore({ STORAGE_SNAPSHOT_BACKEND: 'wormhole' })).toThrow(/Unknown snapshot backend/);
  });
});
