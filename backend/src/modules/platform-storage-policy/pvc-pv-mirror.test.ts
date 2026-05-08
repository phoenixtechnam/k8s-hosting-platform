import { describe, expect, it, vi } from 'vitest';
import {
  computeMirrorDrift,
  desiredMirrorLabels,
  mirrorPvcLabelsToPvs,
} from './pvc-pv-mirror.js';

describe('desiredMirrorLabels', () => {
  it('returns only the four canonical keys', () => {
    const desired = desiredMirrorLabels({
      'platform/role': 'client-storage',
      'platform/owner': 'client:abc12345',
      'platform/canonical-name': 'client-acme-abc12345-storage',
      'platform/managed-by': 'platform-api',
      'app.kubernetes.io/part-of': 'hosting-platform',
      'recurring-job-group.longhorn.io/default': 'enabled',
    });
    expect(desired).toEqual({
      'platform/role': 'client-storage',
      'platform/owner': 'client:abc12345',
      'platform/canonical-name': 'client-acme-abc12345-storage',
      'platform/managed-by': 'platform-api',
    });
  });

  it('omits the canonical-name key when it is absent (CNPG-instance case)', () => {
    const desired = desiredMirrorLabels({
      'platform/role': 'system-db',
      'platform/owner': 'system',
      'platform/managed-by': 'platform-api',
    });
    expect(desired).not.toHaveProperty('platform/canonical-name');
    expect(Object.keys(desired)).toHaveLength(3);
  });

  it('handles undefined/empty input', () => {
    expect(desiredMirrorLabels(undefined)).toEqual({});
    expect(desiredMirrorLabels({})).toEqual({});
  });

  it('skips empty-string label values', () => {
    expect(desiredMirrorLabels({ 'platform/role': '', 'platform/owner': 'system' })).toEqual({
      'platform/owner': 'system',
    });
  });
});

describe('computeMirrorDrift', () => {
  it('returns null when PV labels match desired exactly', () => {
    expect(
      computeMirrorDrift(
        { 'platform/role': 'system-db', 'platform/owner': 'system' },
        { 'platform/role': 'system-db', 'platform/owner': 'system', 'kubernetes.io/foo': 'bar' },
      ),
    ).toBeNull();
  });

  it('returns only the drifted keys', () => {
    expect(
      computeMirrorDrift(
        { 'platform/role': 'mail-db', 'platform/owner': 'mail' },
        { 'platform/role': 'system-db' /* old */, 'platform/owner': 'mail' },
      ),
    ).toEqual({ 'platform/role': 'mail-db' });
  });

  it('returns all desired when PV has no labels at all', () => {
    expect(
      computeMirrorDrift({ 'platform/role': 'system-db' }, undefined),
    ).toEqual({ 'platform/role': 'system-db' });
  });

  it('does NOT remove labels that exist on the PV but not in desired (additive only)', () => {
    // Strategic-merge applies what we send; we never request label deletion.
    // A PV that has a stale platform/canonical-name from a prior tier-flip
    // simply gets rewritten — but extra label keys we don't manage are safe.
    expect(
      computeMirrorDrift(
        { 'platform/role': 'system-db' },
        { 'platform/role': 'system-db', 'platform/canonical-name': 'stale' },
      ),
    ).toBeNull();
  });
});

describe('mirrorPvcLabelsToPvs', () => {
  function makeK8s(opts: {
    pvcs: Array<{
      name?: string;
      labels?: Record<string, string>;
      volumeName?: string;
    }>;
    pvLabels?: Record<string, Record<string, string> | undefined>;
    pvReadShouldFailFor?: Set<string>;
    pvPatchShouldFailFor?: Set<string>;
    pvReadStatusFor?: Map<string, number>;
  }) {
    const list = vi.fn().mockResolvedValue({
      items: opts.pvcs.map((p) => ({
        metadata: { name: p.name, labels: p.labels },
        spec: { volumeName: p.volumeName },
      })),
    });
    const read = vi.fn().mockImplementation(async ({ name }: { name: string }) => {
      if (opts.pvReadStatusFor?.has(name)) {
        const e: Error & { statusCode?: number } = new Error('not found');
        e.statusCode = opts.pvReadStatusFor.get(name)!;
        throw e;
      }
      if (opts.pvReadShouldFailFor?.has(name)) {
        throw new Error(`read fail ${name}`);
      }
      return { metadata: { labels: opts.pvLabels?.[name] } };
    });
    const patch = vi.fn().mockImplementation(async ({ name }: { name: string }) => {
      if (opts.pvPatchShouldFailFor?.has(name)) {
        throw new Error(`patch fail ${name}`);
      }
      return {};
    });
    return {
      list,
      read,
      patch,
      k8s: {
        core: {
          listPersistentVolumeClaimForAllNamespaces: list,
          readPersistentVolume: read,
          patchPersistentVolume: patch,
        },
      } as unknown as Parameters<typeof mirrorPvcLabelsToPvs>[0],
    };
  }

  it('lists PVCs by managed-by selector and patches drifted PVs', async () => {
    const fixture = makeK8s({
      pvcs: [
        {
          name: 'system-db-1',
          volumeName: 'pvc-uuid-1',
          labels: {
            'platform/role': 'system-db',
            'platform/owner': 'system',
            'platform/managed-by': 'platform-api',
          },
        },
      ],
      pvLabels: { 'pvc-uuid-1': {} }, // no canonical labels yet — drift
    });

    const result = await mirrorPvcLabelsToPvs(fixture.k8s);

    expect(fixture.list).toHaveBeenCalledWith({
      labelSelector: 'platform/managed-by=platform-api',
    });
    expect(fixture.patch).toHaveBeenCalledTimes(1);
    // The patch call now passes a second argument (MERGE_PATCH options) so
    // the k8s client library overrides Content-Type to
    // application/merge-patch+json instead of the default json-patch+json.
    const [bodyArg, optsArg] = fixture.patch.mock.calls[0];
    expect(optsArg).toBeDefined();
    expect(bodyArg).toMatchObject({
      name: 'pvc-uuid-1',
      body: {
        metadata: {
          labels: {
            'platform/role': 'system-db',
            'platform/owner': 'system',
            'platform/managed-by': 'platform-api',
          },
        },
      },
    });
    expect(result.patched).toBe(1);
    expect(result.scanned).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('skips PVCs that are not yet bound', async () => {
    const fixture = makeK8s({
      pvcs: [
        {
          name: 'pending-pvc',
          volumeName: undefined, // not bound
          labels: { 'platform/role': 'client-storage', 'platform/owner': 'client:abc12345', 'platform/managed-by': 'platform-api' },
        },
      ],
    });
    const result = await mirrorPvcLabelsToPvs(fixture.k8s);
    expect(fixture.read).not.toHaveBeenCalled();
    expect(fixture.patch).not.toHaveBeenCalled();
    expect(result.patched).toBe(0);
    expect(result.scanned).toBe(1);
  });

  it('does NOT patch when PV labels already match (idempotent)', async () => {
    const fixture = makeK8s({
      pvcs: [
        {
          name: 'mail-db-1',
          volumeName: 'pvc-uuid-2',
          labels: { 'platform/role': 'mail-db', 'platform/owner': 'mail', 'platform/managed-by': 'platform-api' },
        },
      ],
      pvLabels: {
        'pvc-uuid-2': { 'platform/role': 'mail-db', 'platform/owner': 'mail', 'platform/managed-by': 'platform-api' },
      },
    });
    const result = await mirrorPvcLabelsToPvs(fixture.k8s);
    expect(fixture.read).toHaveBeenCalledTimes(1);
    expect(fixture.patch).not.toHaveBeenCalled();
    expect(result.patched).toBe(0);
  });

  it('skips silently when PV vanished (404 between list and read)', async () => {
    const fixture = makeK8s({
      pvcs: [
        {
          name: 'gone',
          volumeName: 'pvc-gone',
          labels: { 'platform/role': 'client-storage', 'platform/owner': 'client:11112222', 'platform/managed-by': 'platform-api' },
        },
      ],
      pvReadStatusFor: new Map([['pvc-gone', 404]]),
    });
    const result = await mirrorPvcLabelsToPvs(fixture.k8s);
    expect(result.errors).toEqual([]);
    expect(result.patched).toBe(0);
  });

  it('records per-PV errors but continues across the batch', async () => {
    const fixture = makeK8s({
      pvcs: [
        {
          name: 'good',
          volumeName: 'pvc-good',
          labels: { 'platform/role': 'client-storage', 'platform/owner': 'client:aaaa1111', 'platform/managed-by': 'platform-api' },
        },
        {
          name: 'bad',
          volumeName: 'pvc-bad',
          labels: { 'platform/role': 'client-storage', 'platform/owner': 'client:bbbb2222', 'platform/managed-by': 'platform-api' },
        },
      ],
      pvPatchShouldFailFor: new Set(['pvc-bad']),
      pvLabels: { 'pvc-good': {}, 'pvc-bad': {} },
    });
    const result = await mirrorPvcLabelsToPvs(fixture.k8s);
    expect(result.scanned).toBe(2);
    expect(result.patched).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('pvc-bad');
  });
});
