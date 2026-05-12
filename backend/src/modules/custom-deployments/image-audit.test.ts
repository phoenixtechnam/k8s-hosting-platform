import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recordImageAudit, _resetAuditFlagCache } from './image-audit.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

function podWith(containers: Array<{ image: string; imageID: string }>): { items: unknown[] } {
  return {
    items: [{
      status: {
        containerStatuses: containers.map((c) => ({ name: 'c', image: c.image, imageID: c.imageID })),
      },
    }],
  };
}

function stubK8s(podList: unknown): K8sClients {
  return {
    core: {
      listNamespacedPod: vi.fn().mockResolvedValue(podList),
    } as unknown as K8sClients['core'],
    apps: {} as K8sClients['apps'],
    networking: {} as K8sClients['networking'],
  };
}

function stubDb(flagEnabled: boolean, sentinelExists = false): {
  db: Database;
  inserts: unknown[];
  updates: unknown[];
} {
  const inserts: unknown[] = [];
  const updates: unknown[] = [];
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        limit: vi.fn(async () => [{ enabled: flagEnabled }]),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (v: unknown) => { inserts.push(v); }),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => {
            updates.push('updated');
            // Default: NO sentinel row exists (production-most-common
            // path) → returns empty → forces the insert branch.
            // Pass `sentinelExists=true` to simulate a real sentinel
            // present in the table (used in the sentinel-conversion
            // test specifically).
            return sentinelExists ? [{ id: 'audit-1' }] : [];
          }),
        })),
      })),
    })),
  } as unknown as Database;
  return { db, inserts, updates };
}

beforeEach(() => {
  _resetAuditFlagCache();
});

describe('recordImageAudit — flag gating', () => {
  it('no-ops when system_settings has audit disabled', async () => {
    const { db, inserts } = stubDb(false);
    const k8s = stubK8s(podWith([{ image: 'nginx:1.27', imageID: 'docker-pullable://nginx@sha256:' + 'a'.repeat(64) }]));
    const n = await recordImageAudit(db, k8s, 'dep-1', 'ns', 'my-app');
    expect(n).toBe(0);
    expect(inserts).toHaveLength(0);
    expect(k8s.core.listNamespacedPod).not.toHaveBeenCalled();
  });

  it('queries pods when audit is enabled', async () => {
    const { db } = stubDb(true);
    const k8s = stubK8s(podWith([{ image: 'nginx:1.27', imageID: 'nginx@sha256:' + 'a'.repeat(64) }]));
    await recordImageAudit(db, k8s, 'dep-1', 'ns', 'my-app');
    expect(k8s.core.listNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'ns', labelSelector: 'app=my-app' }),
    );
  });
});

describe('recordImageAudit — digest parsing', () => {
  it('records resolved digest from docker-pullable:// imageID', async () => {
    const { db, inserts } = stubDb(true);
    const digest = 'sha256:' + 'a'.repeat(64);
    const k8s = stubK8s(podWith([{ image: 'nginx:1.27', imageID: `docker-pullable://nginx@${digest}` }]));
    const n = await recordImageAudit(db, k8s, 'dep-1', 'ns', 'my-app');
    expect(n).toBeGreaterThan(0);
    expect(inserts[0]).toMatchObject({
      deploymentId: 'dep-1',
      image: 'nginx:1.27',
      resolvedDigest: digest,
    });
  });

  it('records resolved digest from containerd:// imageID', async () => {
    const { db, inserts } = stubDb(true);
    const digest = 'sha256:' + 'b'.repeat(64);
    const k8s = stubK8s(podWith([{ image: 'nginx:1.27', imageID: `containerd://nginx@${digest}` }]));
    await recordImageAudit(db, k8s, 'dep-1', 'ns', 'my-app');
    expect((inserts[0] as { resolvedDigest: string }).resolvedDigest).toBe(digest);
  });

  it('records sentinel row when imageID has no digest', async () => {
    const { db, inserts } = stubDb(true);
    const k8s = stubK8s(podWith([{ image: 'nginx:1.27', imageID: '' }]));
    await recordImageAudit(db, k8s, 'dep-1', 'ns', 'my-app');
    expect((inserts[0] as { resolvedDigest: string | null }).resolvedDigest).toBe(null);
  });

  it('records sentinel row when imageID format is unexpected', async () => {
    const { db, inserts } = stubDb(true);
    const k8s = stubK8s(podWith([{ image: 'nginx:1.27', imageID: 'somerandomstring' }]));
    await recordImageAudit(db, k8s, 'dep-1', 'ns', 'my-app');
    expect((inserts[0] as { resolvedDigest: string | null }).resolvedDigest).toBe(null);
  });
});

describe('recordImageAudit — dedupe', () => {
  it('returns 0 when no pods match (no audit rows touched)', async () => {
    const { db, inserts } = stubDb(true);
    const k8s = stubK8s({ items: [] });
    const n = await recordImageAudit(db, k8s, 'dep-1', 'ns', 'my-app');
    expect(n).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it('records all distinct images across containers', async () => {
    const { db, inserts } = stubDb(true);
    const digestA = 'sha256:' + 'a'.repeat(64);
    const digestB = 'sha256:' + 'b'.repeat(64);
    const k8s = stubK8s(podWith([
      { image: 'app:1.0', imageID: `app@${digestA}` },
      { image: 'sidecar:1.0', imageID: `sidecar@${digestB}` },
    ]));
    await recordImageAudit(db, k8s, 'dep-1', 'ns', 'my-app');
    expect(inserts.length).toBe(2);
  });

  it('swallows 23505 unique violations (concurrent insert race)', async () => {
    // Simulate the DB throwing on the resolved insert path. The
    // stubDb update path returns empty (forcing insert), but we
    // override insert to throw a pg unique-violation.
    const { db } = stubDb(true);
    (db.insert as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      values: vi.fn().mockRejectedValue(Object.assign(new Error('duplicate'), { code: '23505' })),
    }));
    const k8s = stubK8s(podWith([{ image: 'nginx:1.27', imageID: '' }]));
    await expect(recordImageAudit(db, k8s, 'dep-1', 'ns', 'my-app')).resolves.not.toThrow();
  });
});
