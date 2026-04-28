import { describe, it, expect } from 'vitest';
import * as k8s from '@kubernetes/client-node';
import { parseJob, summariseHealth, findNewFailures } from './service.js';
import {
  LABEL_HEALTH_WATCH,
  LABEL_CATEGORY,
  LABEL_SEVERITY,
  LABEL_CLIENT_ID,
  ANNOTATION_DISPLAY_NAME,
} from './labels.js';

function makeJob(overrides: {
  uid: string;
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ownerCronJob?: string;
  state?: 'succeeded' | 'failed' | 'running';
  startTime?: string;
  completionTime?: string;
  failureMessage?: string;
}): k8s.V1Job {
  const labels = {
    [LABEL_HEALTH_WATCH]: 'true',
    ...(overrides.labels ?? {}),
  };
  const status: k8s.V1JobStatus = {
    startTime: overrides.startTime ? new Date(overrides.startTime) : undefined,
    completionTime: overrides.completionTime
      ? new Date(overrides.completionTime)
      : undefined,
  };
  if (overrides.state === 'succeeded') {
    status.succeeded = 1;
    status.conditions = [
      {
        type: 'Complete',
        status: 'True',
        lastProbeTime: undefined,
        lastTransitionTime: undefined,
      } as k8s.V1JobCondition,
    ];
  } else if (overrides.state === 'failed') {
    status.failed = 1;
    status.conditions = [
      {
        type: 'Failed',
        status: 'True',
        message: overrides.failureMessage ?? 'job failed',
        lastProbeTime: undefined,
        lastTransitionTime: undefined,
      } as k8s.V1JobCondition,
    ];
  } else if (overrides.state === 'running') {
    status.active = 1;
  }

  const job: k8s.V1Job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      uid: overrides.uid,
      name: overrides.name,
      namespace: overrides.namespace ?? 'platform',
      labels,
      annotations: overrides.annotations,
      ownerReferences: overrides.ownerCronJob
        ? [
            {
              apiVersion: 'batch/v1',
              kind: 'CronJob',
              name: overrides.ownerCronJob,
              uid: 'cron-' + overrides.ownerCronJob,
            },
          ]
        : [],
    },
    spec: {} as k8s.V1JobSpec,
    status,
  };
  return job;
}

describe('parseJob', () => {
  it('extracts metadata from a labelled Job', () => {
    const job = makeJob({
      uid: 'u-1',
      name: 'platform-pg-backup-1',
      ownerCronJob: 'platform-pg-backup',
      labels: {
        [LABEL_CATEGORY]: 'dr',
        [LABEL_SEVERITY]: 'critical',
      },
      annotations: { [ANNOTATION_DISPLAY_NAME]: 'Postgres logical dump' },
      state: 'succeeded',
      startTime: '2026-04-27T22:00:00Z',
      completionTime: '2026-04-27T22:01:00Z',
    });
    const meta = parseJob(job);
    expect(meta).not.toBeNull();
    expect(meta?.uid).toBe('u-1');
    expect(meta?.groupKey).toBe('platform-pg-backup');
    expect(meta?.displayName).toBe('Postgres logical dump');
    expect(meta?.category).toBe('dr');
    expect(meta?.severity).toBe('critical');
    expect(meta?.state).toBe('succeeded');
    expect(meta?.clientId).toBeNull();
  });

  it('falls back to defaults when optional labels are missing', () => {
    const job = makeJob({ uid: 'u-2', name: 'one-off-job' });
    const meta = parseJob(job);
    expect(meta?.category).toBe('custom');
    expect(meta?.severity).toBe('warning');
    expect(meta?.displayName).toBe('one-off-job');
    expect(meta?.groupKey).toBe('one-off-job');
  });

  it('extracts client-id when label present', () => {
    const job = makeJob({
      uid: 'u-3',
      name: 'tenant-backup-1',
      labels: { [LABEL_CLIENT_ID]: 'client-abc', [LABEL_CATEGORY]: 'tenant' },
    });
    const meta = parseJob(job);
    expect(meta?.clientId).toBe('client-abc');
    expect(meta?.category).toBe('tenant');
  });

  it('returns null for Jobs missing identity fields', () => {
    const incomplete: k8s.V1Job = { metadata: { name: 'no-uid' } } as k8s.V1Job;
    expect(parseJob(incomplete)).toBeNull();
  });

  it('captures failure reason from Failed condition', () => {
    const job = makeJob({
      uid: 'u-4',
      name: 'fail',
      state: 'failed',
      failureMessage: 'image pull backoff',
    });
    const meta = parseJob(job);
    expect(meta?.state).toBe('failed');
    expect(meta?.failureReason).toBe('image pull backoff');
  });
});

describe('summariseHealth', () => {
  it('reports failing when newest failure post-dates last success', () => {
    const success = parseJob(
      makeJob({
        uid: 's',
        name: 'pg-1',
        ownerCronJob: 'pg-cron',
        state: 'succeeded',
        startTime: '2026-04-26T22:00:00Z',
      }),
    )!;
    const failure = parseJob(
      makeJob({
        uid: 'f',
        name: 'pg-2',
        ownerCronJob: 'pg-cron',
        state: 'failed',
        startTime: '2026-04-27T22:00:00Z',
        failureMessage: 'oops',
      }),
    )!;
    const summary = summariseHealth([success, failure]);
    expect(summary).toHaveLength(1);
    expect(summary[0]?.state).toBe('failing');
    expect(summary[0]?.lastFailedReason).toBe('oops');
  });

  it('reports healthy when newest run succeeded after last failure', () => {
    const failure = parseJob(
      makeJob({
        uid: 'f',
        name: 'pg-1',
        ownerCronJob: 'pg-cron',
        state: 'failed',
        startTime: '2026-04-26T22:00:00Z',
      }),
    )!;
    const success = parseJob(
      makeJob({
        uid: 's',
        name: 'pg-2',
        ownerCronJob: 'pg-cron',
        state: 'succeeded',
        startTime: '2026-04-27T22:00:00Z',
      }),
    )!;
    const summary = summariseHealth([failure, success]);
    expect(summary[0]?.state).toBe('healthy');
  });

  it('reports never_run when no run has terminal status', () => {
    const running = parseJob(
      makeJob({ uid: 'r', name: 'pg-1', ownerCronJob: 'pg-cron', state: 'running' }),
    )!;
    expect(summariseHealth([running])[0]?.state).toBe('never_run');
  });

  it('orders failing groups before healthy ones', () => {
    const failingA = parseJob(
      makeJob({
        uid: 'fA',
        name: 'a-1',
        ownerCronJob: 'a',
        state: 'failed',
        startTime: '2026-04-27T00:00:00Z',
      }),
    )!;
    const healthyB = parseJob(
      makeJob({
        uid: 'sB',
        name: 'b-1',
        ownerCronJob: 'b',
        state: 'succeeded',
        startTime: '2026-04-27T00:00:00Z',
      }),
    )!;
    const summary = summariseHealth([healthyB, failingA]);
    expect(summary.map((s) => s.groupKey)).toEqual(['a', 'b']);
  });
});

describe('findNewFailures', () => {
  it('returns failures whose UID is not in the already-notified set', () => {
    const f1 = parseJob(
      makeJob({ uid: 'u1', name: 'a', state: 'failed' }),
    )!;
    const f2 = parseJob(
      makeJob({ uid: 'u2', name: 'b', state: 'failed' }),
    )!;
    const ok = parseJob(makeJob({ uid: 'u3', name: 'c', state: 'succeeded' }))!;
    const result = findNewFailures([f1, f2, ok], new Set(['u1']));
    expect(result.map((r) => r.uid)).toEqual(['u2']);
  });

  it('ignores non-failed states even when uid is unknown', () => {
    const running = parseJob(makeJob({ uid: 'r', name: 'r', state: 'running' }))!;
    const result = findNewFailures([running], new Set());
    expect(result).toEqual([]);
  });
});
