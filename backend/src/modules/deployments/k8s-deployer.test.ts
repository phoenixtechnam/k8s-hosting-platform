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

describe('deployCatalogEntry: per-component volume scoping', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('WordPress-shaped install: wordpress only mounts content, mariadb only database, redis nothing, wp-cron gets content', async () => {
    const { k8s, calls } = makeK8sMock();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await deployCatalogEntry(k8s, baseInput({
      components: [
        makeComponent('deployment', { name: 'wordpress', image: 'wordpress:6.9', ports: [{ port: 80, protocol: 'TCP' }], volumes: ['content'] } as Partial<DeployComponentInput>),
        makeComponent('deployment', { name: 'mariadb',   image: 'mariadb:11.8',  ports: [{ port: 3306, protocol: 'TCP' }], volumes: ['database'] } as Partial<DeployComponentInput>),
        makeComponent('deployment', { name: 'redis',     image: 'redis:8',       ports: [{ port: 6379, protocol: 'TCP' }], volumes: [] } as Partial<DeployComponentInput>),
        makeComponent('cronjob',    { name: 'wp-cron',   image: 'wordpress:6.9', schedule: '*/15 * * * *', volumes: ['content'] } as Partial<DeployComponentInput>),
      ],
      volumes: [
        { container_path: '/var/www/html/wp-content', local_path: 'applications/wordpress/content' },
        { container_path: '/var/lib/mysql',            local_path: 'applications/wordpress/database' },
      ],
      storagePath: 'applications/wordpress/my-wp',
    }));
    warnSpy.mockRestore();

    expect(calls.createDeployment).toHaveBeenCalledTimes(3);
    expect(calls.createCronJob).toHaveBeenCalledTimes(1);

    const wpBody = calls.createDeployment.mock.calls.find((c: [{ body: { metadata: { name: string } } }]) => c[0].body.metadata.name === 'my-wp-wordpress')![0].body;
    const mariadbBody = calls.createDeployment.mock.calls.find((c: [{ body: { metadata: { name: string } } }]) => c[0].body.metadata.name === 'my-wp-mariadb')![0].body;
    const redisBody = calls.createDeployment.mock.calls.find((c: [{ body: { metadata: { name: string } } }]) => c[0].body.metadata.name === 'my-wp-redis')![0].body;
    const cronBody = calls.createCronJob.mock.calls[0][0].body;

    // wordpress: only content
    const wpMounts = wpBody.spec.template.spec.containers[0].volumeMounts;
    expect(wpMounts).toHaveLength(1);
    expect(wpMounts[0]).toMatchObject({ mountPath: '/var/www/html/wp-content', subPath: 'applications/wordpress/my-wp/content' });

    // mariadb: only database
    const mdbMounts = mariadbBody.spec.template.spec.containers[0].volumeMounts;
    expect(mdbMounts).toHaveLength(1);
    expect(mdbMounts[0]).toMatchObject({ mountPath: '/var/lib/mysql', subPath: 'applications/wordpress/my-wp/database' });

    // redis: nothing — no volumeMounts, no podVolumes, no init-dirs
    expect(redisBody.spec.template.spec.containers[0].volumeMounts).toBeUndefined();
    expect(redisBody.spec.template.spec.volumes).toBeUndefined();
    expect(redisBody.spec.template.spec.initContainers).toBeUndefined();

    // wp-cron: content mount inside jobTemplate
    const cronPodSpec = cronBody.spec.jobTemplate.spec.template.spec;
    const cronMounts = cronPodSpec.containers[0].volumeMounts;
    expect(cronMounts).toHaveLength(1);
    expect(cronMounts[0]).toMatchObject({ mountPath: '/var/www/html/wp-content', subPath: 'applications/wordpress/my-wp/content' });
    expect(cronPodSpec.volumes).toBeDefined();
    expect(cronPodSpec.initContainers).toBeDefined();
  });

  it('component without `volumes` key falls back to share-all (legacy behavior)', async () => {
    const { k8s, calls } = makeK8sMock();
    await deployCatalogEntry(k8s, baseInput({
      components: [
        // `volumes` unset deliberately.
        makeComponent('deployment', { name: 'app', image: 'app:1', ports: [{ port: 80, protocol: 'TCP' }] }),
      ],
      volumes: [
        { container_path: '/app/a', local_path: 'x/a' },
        { container_path: '/app/b', local_path: 'x/b' },
      ],
      storagePath: 'x/inst',
    }));
    const body = calls.createDeployment.mock.calls[0][0].body;
    const mounts = body.spec.template.spec.containers[0].volumeMounts;
    expect(mounts.map((m: { subPath: string }) => m.subPath).sort()).toEqual(['x/inst/a', 'x/inst/b']);
  });

  it('Job component mounts its declared volumes', async () => {
    const { k8s, calls } = makeK8sMock();
    await deployCatalogEntry(k8s, baseInput({
      components: [
        makeComponent('job', { name: 'migrate', image: 'mig:1', volumes: ['data'] } as Partial<DeployComponentInput>),
      ],
      volumes: [{ container_path: '/work', local_path: 'app/data' }],
      storagePath: 'app/inst',
    }));
    const body = calls.createJob.mock.calls[0][0].body;
    const podSpec = body.spec.template.spec;
    expect(podSpec.containers[0].volumeMounts).toEqual([{ name: 'client-storage', mountPath: '/work', subPath: 'app/inst/data' }]);
    expect(podSpec.initContainers).toHaveLength(1);
    expect(podSpec.volumes).toBeDefined();
  });
});

describe('deployCatalogEntry: env var filtering + templating', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  function envOf(body: { spec: { template: { spec: { containers: Array<{ env?: Array<{ name: string; value: string }> }> } } } }): Record<string, string> {
    const env = body.spec.template.spec.containers[0].env ?? [];
    return Object.fromEntries(env.map(e => [e.name, e.value]));
  }

  it('{{SERVICE:<component>}} resolves to the sibling service name', async () => {
    const { k8s, calls } = makeK8sMock();
    await deployCatalogEntry(k8s, baseInput({
      deploymentName: 'my-wp',
      components: [
        makeComponent('deployment', { name: 'wordpress', image: 'wp:1', ports: [{ port: 80, protocol: 'TCP' }] }),
        makeComponent('deployment', { name: 'mariadb',   image: 'mariadb:11.8', ports: [{ port: 3306, protocol: 'TCP' }] }),
      ],
      envVars: { fixed: { WORDPRESS_DB_HOST: '{{SERVICE:mariadb}}' } },
    }));
    const wpBody = calls.createDeployment.mock.calls.find((c: [{ body: { metadata: { name: string } } }]) => c[0].body.metadata.name === 'my-wp-wordpress')![0].body;
    expect(envOf(wpBody).WORDPRESS_DB_HOST).toBe('my-wp-mariadb');
  });

  it('{{ENV:<name>}} resolves to another env var value (password aliasing)', async () => {
    const { k8s, calls } = makeK8sMock();
    await deployCatalogEntry(k8s, baseInput({
      deploymentName: 'my-wp',
      components: [makeComponent('deployment', { name: 'wordpress', image: 'wp:1', ports: [{ port: 80, protocol: 'TCP' }] })],
      envVars: {
        fixed: { WORDPRESS_DB_PASSWORD: '{{ENV:SHARED_DB_PW}}' },
        // SHARED_DB_PW comes from generated (stored in configuration by service.ts)
      },
      configuration: { SHARED_DB_PW: 'letmein-generated' },
      configurableEnvKeys: ['SHARED_DB_PW'],
    }));
    const body = calls.createDeployment.mock.calls[0][0].body;
    const env = envOf(body);
    expect(env.WORDPRESS_DB_PASSWORD).toBe('letmein-generated');
  });

  it('unrecognized configuration keys are not leaked into container env', async () => {
    // The preexisting bug: wordpress.siteTitle etc. landed in pod env.
    const { k8s, calls } = makeK8sMock();
    await deployCatalogEntry(k8s, baseInput({
      components: [makeComponent('deployment', { name: 'wordpress', image: 'wp:1', ports: [{ port: 80, protocol: 'TCP' }] })],
      envVars: { fixed: { WORDPRESS_DB_NAME: 'wordpress' } },
      configuration: {
        'wordpress.siteTitle': 'My Blog',                 // meta param — NOT an env var
        'WORDPRESS_TABLE_PREFIX': 'wp_',                   // declared configurable — IS an env var
        'MARIADB_ROOT_PASSWORD': 'autogen-xyz',            // declared generated — IS an env var
      },
      configurableEnvKeys: ['WORDPRESS_TABLE_PREFIX', 'MARIADB_ROOT_PASSWORD'],
    }));
    const body = calls.createDeployment.mock.calls[0][0].body;
    const env = envOf(body);
    expect(env).toHaveProperty('WORDPRESS_DB_NAME', 'wordpress');
    expect(env).toHaveProperty('WORDPRESS_TABLE_PREFIX', 'wp_');
    expect(env).toHaveProperty('MARIADB_ROOT_PASSWORD', 'autogen-xyz');
    expect(env).not.toHaveProperty('wordpress.siteTitle');
  });

  it('legacy input (no configurableEnvKeys provided) still accepts configuration keys (backward compat)', async () => {
    const { k8s, calls } = makeK8sMock();
    await deployCatalogEntry(k8s, baseInput({
      components: [makeComponent('deployment', { name: 'app', image: 'a:1', ports: [{ port: 80, protocol: 'TCP' }] })],
      configuration: { FOO: 'bar', 'some.meta': 'x' },
      // configurableEnvKeys deliberately unset
    }));
    const body = calls.createDeployment.mock.calls[0][0].body;
    const env = envOf(body);
    // Legacy behavior: all stringish config keys pass through.
    expect(env.FOO).toBe('bar');
    expect(env['some.meta']).toBe('x');
  });

  it('unresolved {{SERVICE:x}} for missing component throws', async () => {
    const { k8s } = makeK8sMock();
    await expect(deployCatalogEntry(k8s, baseInput({
      deploymentName: 'my-wp',
      components: [makeComponent('deployment', { name: 'wordpress', image: 'wp:1', ports: [{ port: 80, protocol: 'TCP' }] })],
      envVars: { fixed: { WORDPRESS_DB_HOST: '{{SERVICE:nowhere}}' } },
    }))).rejects.toThrow(/unknown component/i);
  });
});

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
