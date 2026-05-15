import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * placement.ts unit tests — covers the 2026-05-14 streamline self-heal:
 * `getMailPlacement` reads the live Stalwart pod's nodeName and
 * lazily updates `system_settings.mailActiveNode` if it differs from
 * the stored value. Catches the drift the streamline E2E harness G4
 * exposed: pod is on staging3 but DB.mailActiveNode is null because
 * the column is only written by migration runs.
 */

const mockListNode = vi.fn();
const mockListNamespacedPod = vi.fn();

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {
    loadFromCluster() {}
    loadFromFile() {}
    makeApiClient(api: unknown) {
      const name = (api as { name?: string })?.name ?? '';
      if (name === 'CoreV1Api') {
        return {
          listNode: mockListNode,
          listNamespacedPod: mockListNamespacedPod,
        };
      }
      return {};
    }
  },
  CoreV1Api: { name: 'CoreV1Api' },
}));

function buildDb(storedActiveNode: string | null = null) {
  const updateSetWhere = vi.fn().mockResolvedValue(undefined);
  const update = vi.fn(() => ({
    set: vi.fn(() => ({ where: updateSetWhere })),
  }));
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{
            mailPrimaryNode: 'staging1',
            mailSecondaryNode: 'staging2',
            mailTertiaryNode: null,
            mailActiveNode: storedActiveNode,
            mailDrState: 'healthy',
            mailAutoFailoverEnabled: false,
            mailFailoverThresholdSeconds: 300,
            mailLastFailoverAt: null,
            mailPortExposureMode: 'thisNodeOnly',
          }]),
        })),
      })),
      update,
    } as unknown as import('../../db/index.js').Database,
    update,
    updateSetWhere,
  };
}

describe('mail-admin/placement.getMailPlacement self-heal', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockListNode.mockResolvedValue({ items: [] });
    // Reset the per-process debounce cache between tests so each test
    // sees a fresh "never written" state.
    const { _resetPlacementSelfHealCache } = await import('./placement.js');
    _resetPlacementSelfHealCache();
  });

  it('writes mailActiveNode to DB when live pod differs from stored value', async () => {
    mockListNamespacedPod.mockResolvedValue({
      items: [{
        metadata: { name: 'stalwart-mail-abc' },
        spec: { nodeName: 'staging3' },
        status: { phase: 'Running' },
      }],
    });
    const { db, update } = buildDb(null);
    const { getMailPlacement } = await import('./placement.js');
    const r = await getMailPlacement(db, { kubeconfigPath: undefined });
    expect(r.activeNode).toBe('staging3');
    expect(update).toHaveBeenCalled();
  });

  it('does NOT write when live and stored agree (avoid pointless writes)', async () => {
    mockListNamespacedPod.mockResolvedValue({
      items: [{
        metadata: { name: 'stalwart-mail-abc' },
        spec: { nodeName: 'staging3' },
        status: { phase: 'Running' },
      }],
    });
    const { db, update } = buildDb('staging3');
    const { getMailPlacement } = await import('./placement.js');
    const r = await getMailPlacement(db, { kubeconfigPath: undefined });
    expect(r.activeNode).toBe('staging3');
    expect(update).not.toHaveBeenCalled();
  });

  it('excludes pods with deletionTimestamp (rollover race protection)', async () => {
    mockListNamespacedPod.mockResolvedValue({
      items: [
        // Old terminating pod on staging3 — should be ignored
        {
          metadata: { name: 'stalwart-mail-old', deletionTimestamp: '2026-05-14T18:00:00Z' },
          spec: { nodeName: 'staging3' },
          status: { phase: 'Running' },
        },
        // New running pod on staging1 — should be picked
        {
          metadata: { name: 'stalwart-mail-new' },
          spec: { nodeName: 'staging1' },
          status: { phase: 'Running' },
        },
      ],
    });
    const { db } = buildDb('staging3');
    const { getMailPlacement } = await import('./placement.js');
    const r = await getMailPlacement(db, { kubeconfigPath: undefined });
    expect(r.activeNode).toBe('staging1');
  });

  it('falls back to stored value when K8s pod query throws + logs warn', async () => {
    mockListNamespacedPod.mockRejectedValue(new Error('apiserver unreachable'));
    const { db, update } = buildDb('staging2');
    const warn = vi.fn();
    const { getMailPlacement } = await import('./placement.js');
    const r = await getMailPlacement(db, {
      kubeconfigPath: undefined,
      logger: { warn },
    });
    expect(r.activeNode).toBe('staging2');
    expect(update).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('debounces consecutive identical self-heal writes (within 10s)', async () => {
    // Two GET /admin/mail/placement calls landing on the same
    // platform-api pod within the 10s window MUST result in only one
    // DB write — avoid log spam during rollover polling. After 10s,
    // a third call with the same value would write again, but that's
    // outside this test's window.
    mockListNamespacedPod.mockResolvedValue({
      items: [{
        metadata: { name: 'stalwart-mail-abc' },
        spec: { nodeName: 'staging3' },
        status: { phase: 'Running' },
      }],
    });
    const { db, update } = buildDb(null);
    const { getMailPlacement } = await import('./placement.js');
    await getMailPlacement(db, { kubeconfigPath: undefined });
    await getMailPlacement(db, { kubeconfigPath: undefined });
    await getMailPlacement(db, { kubeconfigPath: undefined });
    // First call writes; subsequent two within debounce window skip.
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('returns null activeNode when both live and stored are null', async () => {
    mockListNamespacedPod.mockResolvedValue({ items: [] });
    const { db } = buildDb(null);
    const { getMailPlacement } = await import('./placement.js');
    const r = await getMailPlacement(db, { kubeconfigPath: undefined });
    expect(r.activeNode).toBeNull();
  });
});
