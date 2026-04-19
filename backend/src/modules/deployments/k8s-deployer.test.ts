import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deployCatalogEntry } from './k8s-deployer.js';
import type { DeployCatalogEntryInput, DeployComponentInput } from './k8s-deployer.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

/**
 * Legacy `type: statefulset` manifest values route through the Deployment
 * code path with a deprecation warning. These tests pin both shapes down
 * so a future refactor can't silently re-introduce a real StatefulSet
 * path without failing the build.
 */

function makeK8sMock() {
  const notFound = Object.assign(new Error('HTTP-Code: 404'), { statusCode: 404 });
  const calls = {
    createDeployment: vi.fn().mockResolvedValue({}),
    readDeployment: vi.fn().mockRejectedValue(notFound),
    createStatefulSet: vi.fn().mockResolvedValue({}),
    createService: vi.fn().mockResolvedValue({}),
    readService: vi.fn().mockRejectedValue(notFound),
    createCronJob: vi.fn().mockResolvedValue({}),
    readCronJob: vi.fn().mockRejectedValue(notFound),
    createJob: vi.fn().mockResolvedValue({}),
    readJob: vi.fn().mockRejectedValue(notFound),
  };
  const k8s = {
    apps: {
      createNamespacedDeployment: calls.createDeployment,
      replaceNamespacedDeployment: vi.fn().mockResolvedValue({}),
      readNamespacedDeployment: calls.readDeployment,
      createNamespacedStatefulSet: calls.createStatefulSet,
    },
    core: {
      createNamespacedService: calls.createService,
      replaceNamespacedService: vi.fn().mockResolvedValue({}),
      readNamespacedService: calls.readService,
      deleteNamespacedService: vi.fn().mockResolvedValue({}),
    },
    batch: {
      createNamespacedCronJob: calls.createCronJob,
      replaceNamespacedCronJob: vi.fn().mockResolvedValue({}),
      readNamespacedCronJob: calls.readCronJob,
      createNamespacedJob: calls.createJob,
      readNamespacedJob: calls.readJob,
    },
  } as unknown as K8sClients;
  return { k8s, calls };
}

function baseInput(overrides: Partial<DeployCatalogEntryInput> = {}): DeployCatalogEntryInput {
  return {
    deploymentName: 'my-wp',
    namespace: 'client-test-abcd',
    storagePath: 'applications/wordpress/my-wp',
    components: [],
    volumes: [],
    replicaCount: 1,
    cpuRequest: '250m',
    memoryRequest: '256Mi',
    ...overrides,
  };
}

function makeComponent(type: DeployComponentInput['type'], overrides: Partial<DeployComponentInput> = {}): DeployComponentInput {
  return {
    name: 'c',
    type,
    image: 'img:1',
    ports: [],
    ...overrides,
  } as DeployComponentInput;
}

describe('deployCatalogEntry: component type → k8s resource mapping', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('component type=deployment creates a Deployment (not a StatefulSet)', async () => {
    const { k8s, calls } = makeK8sMock();
    await deployCatalogEntry(k8s, baseInput({
      components: [makeComponent('deployment', { name: 'wp', image: 'wordpress:6.9', ports: [{ port: 80, protocol: 'TCP' }] })],
    }));
    expect(calls.createDeployment).toHaveBeenCalledTimes(1);
    expect(calls.createStatefulSet).not.toHaveBeenCalled();
  });

  it('legacy type=statefulset still emits a Deployment (backward-compat + deprecation warning)', async () => {
    const { k8s, calls } = makeK8sMock();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await deployCatalogEntry(k8s, baseInput({
      components: [makeComponent('statefulset', { name: 'mariadb', image: 'mariadb:11.8', ports: [{ port: 3306, protocol: 'TCP' }] })],
    }));
    expect(calls.createDeployment).toHaveBeenCalledTimes(1);
    expect(calls.createStatefulSet).not.toHaveBeenCalled();
    // The deprecation log names the offending type so operators can locate
    // the catalog manifest that still needs updating.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/deprecated type 'statefulset'/));
    warnSpy.mockRestore();
  });

  it('type=cronjob creates a CronJob, not a Deployment', async () => {
    const { k8s, calls } = makeK8sMock();
    await deployCatalogEntry(k8s, baseInput({
      components: [makeComponent('cronjob', { name: 'wp-cron', image: 'wordpress:6.9', schedule: '*/15 * * * *' })],
    }));
    expect(calls.createCronJob).toHaveBeenCalledTimes(1);
    expect(calls.createDeployment).not.toHaveBeenCalled();
  });

  it('type=job creates a Job (one-shot)', async () => {
    const { k8s, calls } = makeK8sMock();
    await deployCatalogEntry(k8s, baseInput({
      components: [makeComponent('job', { name: 'migrate', image: 'mymigrator:1.0' })],
    }));
    expect(calls.createJob).toHaveBeenCalledTimes(1);
    expect(calls.createDeployment).not.toHaveBeenCalled();
  });

  it('per-volume subPath prevents collision (WordPress wp-content vs mysql data)', async () => {
    const { k8s, calls } = makeK8sMock();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await deployCatalogEntry(k8s, baseInput({
      components: [
        makeComponent('deployment', { name: 'wordpress', image: 'wordpress:6.9', ports: [{ port: 80, protocol: 'TCP' }] }),
        makeComponent('deployment', { name: 'mariadb', image: 'mariadb:11.8', ports: [{ port: 3306, protocol: 'TCP' }] }),
      ],
      volumes: [
        { container_path: '/var/www/html/wp-content', local_path: 'applications/wordpress/content' },
        { container_path: '/var/lib/mysql', local_path: 'applications/wordpress/database' },
      ],
      storagePath: 'applications/wordpress/my-wp',
    }));
    warnSpy.mockRestore();

    expect(calls.createDeployment).toHaveBeenCalledTimes(2);
    const firstBody = calls.createDeployment.mock.calls[0][0].body;
    const mounts = firstBody.spec.template.spec.containers[0].volumeMounts;
    // Two mounts, two distinct subPaths — the whole point of the fix.
    expect(mounts).toHaveLength(2);
    const subPaths = mounts.map((m: { subPath: string }) => m.subPath).sort();
    expect(subPaths).toEqual([
      'applications/wordpress/my-wp/content',
      'applications/wordpress/my-wp/database',
    ]);
    // init-dirs mkdir must create both per-volume subPaths.
    const initCmd = firstBody.spec.template.spec.initContainers[0].command[2];
    expect(initCmd).toContain('mkdir -p /data/applications/wordpress/my-wp/content');
    expect(initCmd).toContain('mkdir -p /data/applications/wordpress/my-wp/database');
  });

  it('falls back to container_path basename when local_path is missing', async () => {
    const { k8s, calls } = makeK8sMock();
    await deployCatalogEntry(k8s, baseInput({
      components: [makeComponent('deployment', { name: 'app', image: 'app:1', ports: [{ port: 80, protocol: 'TCP' }] })],
      volumes: [{ container_path: '/var/lib/mysql' }],
      storagePath: 'applications/legacy/inst',
    }));
    const body = calls.createDeployment.mock.calls[0][0].body;
    const mount = body.spec.template.spec.containers[0].volumeMounts[0];
    expect(mount.subPath).toBe('applications/legacy/inst/mysql');
  });

  it('multi-component app (WordPress: wp + mariadb + wp-cron) creates the right mix', async () => {
    const { k8s, calls } = makeK8sMock();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await deployCatalogEntry(k8s, baseInput({
      components: [
        makeComponent('deployment', { name: 'wordpress', image: 'wordpress:6.9', ports: [{ port: 80, protocol: 'TCP' }] }),
        makeComponent('statefulset', { name: 'mariadb', image: 'mariadb:11.8', ports: [{ port: 3306, protocol: 'TCP' }] }),
        makeComponent('cronjob', { name: 'wp-cron', image: 'wordpress:6.9', schedule: '*/15 * * * *' }),
      ],
    }));
    // wordpress + mariadb → 2 Deployments (statefulset collapses)
    expect(calls.createDeployment).toHaveBeenCalledTimes(2);
    // wp-cron → 1 CronJob
    expect(calls.createCronJob).toHaveBeenCalledTimes(1);
    // Never a StatefulSet — this is the entire point of the shared-PVC model
    expect(calls.createStatefulSet).not.toHaveBeenCalled();
    // Services get created for components that have ports (wordpress + mariadb)
    expect(calls.createService).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });
});
