import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock DB ────────────────────────────────────────────────────────────────

let selectResults: unknown[][];
let selectCallIndex: number;
let updateCalls: Record<string, unknown>[];
let deleteCalls: number;

function createMockDb() {
  selectCallIndex = 0;
  updateCalls = [];
  deleteCalls = 0;

  const whereFn = vi.fn().mockImplementation(() => {
    const result = selectResults[selectCallIndex] ?? [];
    selectCallIndex += 1;
    return Promise.resolve(result);
  });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockImplementation((vals: Record<string, unknown>) => {
    updateCalls.push(vals);
    return { where: updateWhere };
  });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });

  const deleteWhere = vi.fn().mockImplementation(() => {
    deleteCalls += 1;
    return Promise.resolve();
  });
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

  return {
    select: selectFn,
    update: updateFn,
    delete: deleteFn,
  } as unknown as ReturnType<typeof createMockDb>;
}

// ─── Mock K8s clients ───────────────────────────────────────────────────────

let mockJobStatus: { active?: number; succeeded?: number; failed?: number } | null = null;
let mockJobNotFound = false;
interface MockPod {
  metadata?: { name?: string };
  status?: {
    phase?: string;
    conditions?: { type: string; status: string; reason?: string; message?: string }[];
    containerStatuses?: { state?: { waiting?: { reason?: string; message?: string } } }[];
  };
}
let mockPodList: { items: MockPod[] } = { items: [] };
let mockPodLog = '';
let deletedJobs: string[] = [];
let deletedSecrets: string[] = [];

function createMockK8s() {
  return {
    batch: {
      readNamespacedJob: vi.fn().mockImplementation(async () => {
        if (mockJobNotFound) {
          const err = new Error('not found') as Error & { statusCode?: number };
          err.statusCode = 404;
          throw err;
        }
        return { status: mockJobStatus };
      }),
      deleteNamespacedJob: vi.fn().mockImplementation(async ({ name }: { name: string }) => {
        deletedJobs.push(name);
      }),
    },
    core: {
      listNamespacedPod: vi.fn().mockResolvedValue(mockPodList),
      readNamespacedPodLog: vi.fn().mockResolvedValue(mockPodLog),
      deleteNamespacedSecret: vi.fn().mockImplementation(async ({ name }: { name: string }) => {
        deletedSecrets.push(name);
      }),
    },
  };
}

const reconciler = await import('./reconciler.js');

beforeEach(() => {
  selectResults = [];
  selectCallIndex = 0;
  updateCalls = [];
  deleteCalls = 0;
  mockJobStatus = null;
  mockJobNotFound = false;
  mockPodList = { items: [] };
  mockPodLog = '';
  deletedJobs = [];
  deletedSecrets = [];
});

// ═══════════════════════════════════════════════════════════════════════════

describe('reconcileImapSyncJobs', () => {
  it('marks a Job that has succeeded as succeeded and captures the log tail', async () => {
    selectResults = [
      [
        {
          id: 'job-1',
          k8sJobName: 'imapsync-job-1',
          k8sNamespace: 'mail',
          status: 'running',
        },
      ],
    ];
    mockJobStatus = { succeeded: 1 };
    mockPodList = { items: [{ metadata: { name: 'imapsync-job-1-xyz' } }] };
    mockPodLog = 'transferred 200 messages\nDone.\n';

    const db = createMockDb();
    const k8s = createMockK8s();

    await reconciler.reconcileImapSyncJobs(db as never, k8s as never);

    // Should have updated the row to 'succeeded' with finishedAt + log tail
    const succeededUpdate = updateCalls.find((u) => u.status === 'succeeded');
    expect(succeededUpdate).toBeDefined();
    expect(succeededUpdate?.finishedAt).toBeInstanceOf(Date);
    expect(succeededUpdate?.logTail).toContain('Done.');
    // Should have triggered cleanup of Job + Secret
    expect(deletedJobs).toContain('imapsync-job-1');
    expect(deletedSecrets).toContain('imapsync-job-1');
  });

  it('marks a Job that has failed as failed with the captured error log', async () => {
    selectResults = [
      [
        {
          id: 'job-2',
          k8sJobName: 'imapsync-job-2',
          k8sNamespace: 'mail',
          status: 'running',
        },
      ],
    ];
    mockJobStatus = { failed: 1 };
    mockPodList = { items: [{ metadata: { name: 'imapsync-job-2-abc' } }] };
    mockPodLog = 'imapsync: authentication failed for alice@gmail.com\n';

    const db = createMockDb();
    const k8s = createMockK8s();

    await reconciler.reconcileImapSyncJobs(db as never, k8s as never);

    const failedUpdate = updateCalls.find((u) => u.status === 'failed');
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate?.errorMessage).toBeTruthy();
    expect(failedUpdate?.logTail).toContain('authentication failed');
    expect(deletedJobs).toContain('imapsync-job-2');
  });

  it('writes a progress tick (logTail + lastProgressAt) for a still-running job', async () => {
    // Round-4 Phase 3: the reconciler now fetches a fresh log tail
    // and updates progress columns for running jobs (throttled by
    // PROGRESS_FETCH_INTERVAL_MS, but the mock row has lastProgressAt
    // null so the throttle does not block).
    selectResults = [
      [
        {
          id: 'job-3',
          k8sJobName: 'imapsync-job-3',
          k8sNamespace: 'mail',
          status: 'running',
          lastProgressAt: null,
        },
      ],
    ];
    mockJobStatus = { active: 1 };
    mockPodList = { items: [{ metadata: { name: 'imapsync-job-3-pod' } }] };
    mockPodLog = '+ Copying msg 50/200 [INBOX]\n';

    const db = createMockDb();
    const k8s = createMockK8s();

    await reconciler.reconcileImapSyncJobs(db as never, k8s as never);

    // Status was NOT transitioned (still no terminal update).
    expect(updateCalls.find((u) => u.status === 'failed' || u.status === 'succeeded')).toBeUndefined();
    expect(deletedJobs).toEqual([]);
    // ONE progress tick update should have happened with the log tail
    // and the parsed progress values.
    expect(updateCalls.length).toBe(1);
    const progressUpdate = updateCalls[0];
    expect(progressUpdate.logTail).toContain('Copying msg 50/200');
    expect(progressUpdate.messagesTransferred).toBe(50);
    expect(progressUpdate.messagesTotal).toBe(200);
    expect(progressUpdate.currentFolder).toBe('INBOX');
    expect(progressUpdate.lastProgressAt).toBeInstanceOf(Date);
  });

  it('throttles progress fetches — skips when lastProgressAt is recent', async () => {
    // lastProgressAt = now → the throttle blocks the next fetch
    // until PROGRESS_FETCH_INTERVAL_MS has elapsed.
    selectResults = [
      [
        {
          id: 'job-3b',
          k8sJobName: 'imapsync-job-3b',
          k8sNamespace: 'mail',
          status: 'running',
          lastProgressAt: new Date(),
        },
      ],
    ];
    mockJobStatus = { active: 1 };

    const db = createMockDb();
    const k8s = createMockK8s();

    await reconciler.reconcileImapSyncJobs(db as never, k8s as never);

    expect(updateCalls).toEqual([]);
    expect(deletedJobs).toEqual([]);
  });

  it('marks a job as failed when the K8s Job has disappeared (404)', async () => {
    selectResults = [
      [
        {
          id: 'job-4',
          k8sJobName: 'imapsync-job-4',
          k8sNamespace: 'mail',
          status: 'running',
        },
      ],
    ];
    mockJobNotFound = true;

    const db = createMockDb();
    const k8s = createMockK8s();

    await reconciler.reconcileImapSyncJobs(db as never, k8s as never);

    const failedUpdate = updateCalls.find((u) => u.status === 'failed');
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate?.errorMessage).toContain('disappeared');
  });

  // ─── IMAP Phase 3: Pending-pod observability ─────────────────────────

  it('records podPhase + podMessage when the pod is stuck Pending (FailedScheduling)', async () => {
    selectResults = [
      [
        {
          id: 'job-stuck',
          k8sJobName: 'imapsync-job-stuck',
          k8sNamespace: 'mail',
          status: 'running',
          lastProgressAt: null,
        },
      ],
    ];
    mockJobStatus = { active: 1 };
    mockPodList = {
      items: [
        {
          metadata: { name: 'imapsync-job-stuck-pod' },
          status: {
            phase: 'Pending',
            conditions: [
              {
                type: 'PodScheduled',
                status: 'False',
                reason: 'Unschedulable',
                message: '0/1 nodes are available: 1 Too many pods. preemption: 0/1 nodes are available: 1 No preemption victims found for incoming pod.',
              },
            ],
          },
        },
      ],
    };

    const db = createMockDb();
    const k8s = createMockK8s();
    await reconciler.reconcileImapSyncJobs(db as never, k8s as never);

    // Should NOT transition to failed — the job might still recover
    expect(updateCalls.find((u) => u.status === 'failed')).toBeUndefined();
    // Should write podPhase + podMessage on the progress tick
    expect(updateCalls.length).toBe(1);
    const tick = updateCalls[0];
    expect(tick.podPhase).toBe('Pending');
    expect(tick.podMessage).toContain('Too many pods');
  });

  it('records podPhase + podMessage when the pod is in ImagePullBackOff', async () => {
    selectResults = [
      [
        {
          id: 'job-imgfail',
          k8sJobName: 'imapsync-job-imgfail',
          k8sNamespace: 'mail',
          status: 'running',
          lastProgressAt: null,
        },
      ],
    ];
    mockJobStatus = { active: 1 };
    mockPodList = {
      items: [
        {
          metadata: { name: 'imapsync-job-imgfail-pod' },
          status: {
            phase: 'Pending',
            containerStatuses: [
              {
                state: {
                  waiting: {
                    reason: 'ImagePullBackOff',
                    message: 'Back-off pulling image "gilleslamiral/imapsync:2.296"',
                  },
                },
              },
            ],
          },
        },
      ],
    };

    const db = createMockDb();
    const k8s = createMockK8s();
    await reconciler.reconcileImapSyncJobs(db as never, k8s as never);

    const tick = updateCalls[0];
    expect(tick.podPhase).toBe('Pending');
    expect(tick.podMessage).toContain('ImagePullBackOff');
  });

  it('records podPhase=Running and clears podMessage on a healthy running pod', async () => {
    selectResults = [
      [
        {
          id: 'job-ok',
          k8sJobName: 'imapsync-job-ok',
          k8sNamespace: 'mail',
          status: 'running',
          lastProgressAt: null,
        },
      ],
    ];
    mockJobStatus = { active: 1 };
    mockPodList = {
      items: [
        {
          metadata: { name: 'imapsync-job-ok-pod' },
          status: {
            phase: 'Running',
            conditions: [{ type: 'Ready', status: 'True' }],
          },
        },
      ],
    };
    mockPodLog = '+ Copying msg 5/200 [INBOX]\n';

    const db = createMockDb();
    const k8s = createMockK8s();
    await reconciler.reconcileImapSyncJobs(db as never, k8s as never);

    const tick = updateCalls[0];
    expect(tick.podPhase).toBe('Running');
    expect(tick.podMessage).toBe(null);
  });

  it('truncates very long log tails to the configured max', async () => {
    selectResults = [
      [
        {
          id: 'job-5',
          k8sJobName: 'imapsync-job-5',
          k8sNamespace: 'mail',
          status: 'running',
        },
      ],
    ];
    mockJobStatus = { succeeded: 1 };
    mockPodList = { items: [{ metadata: { name: 'imapsync-job-5-pod' } }] };
    mockPodLog = 'X'.repeat(100_000);

    const db = createMockDb();
    const k8s = createMockK8s();

    await reconciler.reconcileImapSyncJobs(db as never, k8s as never);

    const u = updateCalls.find((c) => c.status === 'succeeded');
    expect(u).toBeDefined();
    expect((u?.logTail as string).length).toBeLessThanOrEqual(32 * 1024);
  });
});
