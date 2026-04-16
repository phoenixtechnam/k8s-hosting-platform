import { describe, it, expect } from 'vitest';
import { listDeploymentComponents, findPodForComponent } from './service.js';
import type { V1Pod } from '@kubernetes/client-node';

function makePod(overrides: {
  name: string;
  component: string;
  phase?: string;
  ready?: boolean;
  containerName?: string;
  restartCount?: number;
  managed?: string;
}): V1Pod {
  return {
    metadata: {
      name: overrides.name,
      labels: {
        app: 'my-wordpress',
        component: overrides.component,
        'platform.io/managed': overrides.managed ?? 'true',
      },
    },
    status: {
      phase: overrides.phase ?? 'Running',
      containerStatuses: [
        {
          name: overrides.containerName ?? overrides.component,
          ready: overrides.ready ?? true,
          restartCount: overrides.restartCount ?? 0,
          image: 'test:latest',
          imageID: '',
          started: true,
          state: overrides.phase === 'Pending'
            ? { waiting: { reason: 'ContainerCreating' } }
            : { running: { startedAt: new Date() } },
        },
      ],
    },
  } as V1Pod;
}

describe('listDeploymentComponents', () => {
  it('returns component info from running pods', () => {
    const pods = [
      makePod({ name: 'my-wordpress-wordpress-abc', component: 'wordpress' }),
      makePod({ name: 'my-wordpress-mariadb-def', component: 'mariadb' }),
    ];

    const result = listDeploymentComponents(pods);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      name: 'wordpress',
      podName: 'my-wordpress-wordpress-abc',
      containerName: 'wordpress',
      ready: true,
      status: 'running',
      restarts: 0,
    });
    expect(result[1]?.name).toBe('mariadb');
  });

  it('filters out pods without platform.io/managed label', () => {
    const pods = [
      makePod({ name: 'managed-pod', component: 'app', managed: 'true' }),
      makePod({ name: 'unmanaged-pod', component: 'sidecar', managed: 'false' }),
    ];

    const result = listDeploymentComponents(pods);
    expect(result).toHaveLength(1);
    expect(result[0]?.podName).toBe('managed-pod');
  });

  it('reports waiting status for pending pods', () => {
    const pods = [
      makePod({ name: 'pending-pod', component: 'app', phase: 'Pending', ready: false }),
    ];

    const result = listDeploymentComponents(pods);
    expect(result[0]?.status).toBe('ContainerCreating');
    expect(result[0]?.ready).toBe(false);
  });

  it('tracks restart count', () => {
    const pods = [
      makePod({ name: 'crashloop-pod', component: 'app', restartCount: 5 }),
    ];

    const result = listDeploymentComponents(pods);
    expect(result[0]?.restarts).toBe(5);
  });

  it('returns empty array for no pods', () => {
    expect(listDeploymentComponents([])).toEqual([]);
  });
});

describe('findPodForComponent', () => {
  it('finds running pod matching component name', () => {
    const pods = [
      makePod({ name: 'wp-wordpress-abc', component: 'wordpress' }),
      makePod({ name: 'wp-mariadb-def', component: 'mariadb' }),
    ];

    const result = findPodForComponent(pods, 'mariadb');
    expect(result?.metadata?.name).toBe('wp-mariadb-def');
  });

  it('returns undefined for non-existent component', () => {
    const pods = [
      makePod({ name: 'wp-wordpress-abc', component: 'wordpress' }),
    ];

    expect(findPodForComponent(pods, 'redis')).toBeUndefined();
  });

  it('skips non-running pods', () => {
    const pods = [
      makePod({ name: 'wp-app-abc', component: 'app', phase: 'Pending' }),
    ];

    expect(findPodForComponent(pods, 'app')).toBeUndefined();
  });
});
