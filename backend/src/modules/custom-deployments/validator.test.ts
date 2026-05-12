import { describe, it, expect } from 'vitest';
import { validateCustomSpec, type ValidatorContext } from './validator.js';
import type { CustomDeploymentSpec, CustomDeploymentService } from './schema.js';

// Small fixture builder — keeps the tests focused on the rule being
// exercised rather than the spec-shape boilerplate.
function spec(
  override: Partial<CustomDeploymentSpec> & {
    services?: Record<string, Partial<CustomDeploymentService>>;
  } = {},
): CustomDeploymentSpec {
  const baseService: CustomDeploymentService = {
    image: 'nginx:1.27',
    env: [],
    ports: [],
    volumeMounts: [],
    resources: { cpuRequest: '100m', memoryRequest: '128Mi' },
    restartPolicy: 'Always',
    readOnlyRootFilesystem: false,
    tmpfs: [],
    dependsOn: [],
  };
  const services: Record<string, CustomDeploymentService> = {};
  const inputServices = override.services ?? { web: {} };
  for (const [k, v] of Object.entries(inputServices)) {
    services[k] = { ...baseService, ...v };
  }
  return {
    specVersion: 1,
    sourceMode: 'simple',
    services,
    volumes: override.volumes ?? {},
    configMaps: override.configMaps ?? [],
    secrets: override.secrets ?? [],
    allowRoot: override.allowRoot ?? false,
    pullCredentialId: override.pullCredentialId,
  };
}

const adminCtx: ValidatorContext = {
  callerRole: 'admin',
  warnUnpinnedTags: true,
  singleServiceOnly: true,
};
const clientCtx: ValidatorContext = {
  callerRole: 'client_admin',
  warnUnpinnedTags: true,
  singleServiceOnly: true,
};

describe('validateCustomSpec — happy path', () => {
  it('accepts a minimal pinned spec', () => {
    const r = validateCustomSpec(spec(), clientCtx);
    expect(r.ok).toBe(true);
    expect(r.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });
});

describe('validateCustomSpec — Phase-1 service count', () => {
  it('rejects multi-service in simple-only mode', () => {
    const r = validateCustomSpec(
      spec({ services: { web: {}, db: {} } }),
      clientCtx,
    );
    expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.code === 'COMPOSE_NOT_SUPPORTED_YET')).toBeDefined();
  });
  it('accepts multi-service when singleServiceOnly=false', () => {
    const r = validateCustomSpec(
      spec({ services: { web: {}, db: {} } }),
      { ...clientCtx, singleServiceOnly: false },
    );
    expect(r.issues.find((i) => i.code === 'COMPOSE_NOT_SUPPORTED_YET')).toBeUndefined();
  });
});

describe('validateCustomSpec — allowRoot', () => {
  it('rejects runAsUser:0 without allowRoot', () => {
    const r = validateCustomSpec(
      spec({ services: { web: { runAsUser: 0 } } }),
      clientCtx,
    );
    expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.code === 'ROOT_REQUIRES_ALLOW_ROOT')).toBeDefined();
  });
  it('accepts runAsUser:0 when admin set allowRoot', () => {
    const r = validateCustomSpec(
      spec({ services: { web: { runAsUser: 0 } }, allowRoot: true }),
      adminCtx,
    );
    expect(r.issues.find((i) => i.code === 'ROOT_REQUIRES_ALLOW_ROOT')).toBeUndefined();
  });
  it('rejects allowRoot=true when caller is not admin', () => {
    const r = validateCustomSpec(
      spec({ allowRoot: true }),
      clientCtx,
    );
    expect(r.issues.find((i) => i.code === 'ALLOW_ROOT_REQUIRES_ADMIN')).toBeDefined();
  });
  it('accepts allowRoot=true when caller is super_admin', () => {
    const r = validateCustomSpec(
      spec({ allowRoot: true }),
      { ...adminCtx, callerRole: 'super_admin' },
    );
    expect(r.issues.find((i) => i.code === 'ALLOW_ROOT_REQUIRES_ADMIN')).toBeUndefined();
  });
});

describe('validateCustomSpec — reference integrity', () => {
  it('rejects volumeMount referencing undeclared volume', () => {
    const r = validateCustomSpec(
      spec({
        services: {
          web: { volumeMounts: [{ name: 'orphan', containerPath: '/data', readOnly: false }] },
        },
      }),
      clientCtx,
    );
    expect(r.issues.find((i) => i.code === 'VOLUME_NOT_DECLARED')).toBeDefined();
  });
  it('accepts volumeMount referencing a declared volume', () => {
    const r = validateCustomSpec(
      spec({
        services: {
          web: { volumeMounts: [{ name: 'data', containerPath: '/data', readOnly: false }] },
        },
        volumes: { data: {} },
      }),
      clientCtx,
    );
    expect(r.ok).toBe(true);
  });
  it('rejects env referencing undeclared secret', () => {
    const r = validateCustomSpec(
      spec({
        services: {
          web: { env: [{ name: 'PW', valueFromSecret: 'creds' }] },
        },
      }),
      clientCtx,
    );
    expect(r.issues.find((i) => i.code === 'ENV_SECRET_NOT_DECLARED')).toBeDefined();
  });
  it('rejects env referencing undeclared configMap', () => {
    const r = validateCustomSpec(
      spec({
        services: {
          web: { env: [{ name: 'CFG', valueFromConfigMap: 'app-cfg' }] },
        },
      }),
      clientCtx,
    );
    expect(r.issues.find((i) => i.code === 'ENV_CONFIGMAP_NOT_DECLARED')).toBeDefined();
  });
});

describe('validateCustomSpec — depends_on', () => {
  it('rejects depends_on to undeclared service (multi-service)', () => {
    const r = validateCustomSpec(
      spec({ services: { web: { dependsOn: ['ghost'] } } }),
      { ...clientCtx, singleServiceOnly: false },
    );
    expect(r.issues.find((i) => i.code === 'DEPENDS_ON_UNKNOWN_SERVICE')).toBeDefined();
  });
  it('rejects self-dependency', () => {
    const r = validateCustomSpec(
      spec({ services: { web: { dependsOn: ['web'] } } }),
      { ...clientCtx, singleServiceOnly: false },
    );
    expect(r.issues.find((i) => i.code === 'DEPENDS_ON_SELF')).toBeDefined();
  });
  it('detects two-node cycles', () => {
    const r = validateCustomSpec(
      spec({
        services: {
          web: { dependsOn: ['db'] },
          db: { dependsOn: ['web'] },
        },
      }),
      { ...clientCtx, singleServiceOnly: false },
    );
    expect(r.issues.find((i) => i.code === 'DEPENDS_ON_CYCLE')).toBeDefined();
  });
  it('accepts DAG dependencies', () => {
    const r = validateCustomSpec(
      spec({
        services: {
          web: { dependsOn: ['api'] },
          api: { dependsOn: ['db'] },
          db: {},
        },
      }),
      { ...clientCtx, singleServiceOnly: false },
    );
    expect(r.issues.find((i) => i.code === 'DEPENDS_ON_CYCLE')).toBeUndefined();
  });
});

describe('validateCustomSpec — port rules', () => {
  it('rejects duplicate port names within one service', () => {
    const r = validateCustomSpec(
      spec({
        services: {
          web: {
            ports: [
              { containerPort: 80, name: 'http', protocol: 'TCP', exposeAsService: true, ingressEligible: false },
              { containerPort: 8080, name: 'http', protocol: 'TCP', exposeAsService: true, ingressEligible: false },
            ],
          },
        },
      }),
      clientCtx,
    );
    expect(r.issues.find((i) => i.code === 'PORT_NAME_DUPLICATE')).toBeDefined();
  });
  it('rejects multiple ingressEligible ports (Phase 1 cap)', () => {
    const r = validateCustomSpec(
      spec({
        services: {
          web: {
            ports: [
              { containerPort: 80, name: 'http', protocol: 'TCP', exposeAsService: true, ingressEligible: true },
              { containerPort: 443, name: 'https', protocol: 'TCP', exposeAsService: true, ingressEligible: true },
            ],
          },
        },
      }),
      clientCtx,
    );
    expect(r.issues.find((i) => i.code === 'TOO_MANY_INGRESS_ELIGIBLE_PORTS')).toBeDefined();
  });
});

describe('validateCustomSpec — resource limits', () => {
  it('rejects cpuLimit < cpuRequest', () => {
    const r = validateCustomSpec(
      spec({
        services: {
          web: {
            resources: { cpuRequest: '500m', cpuLimit: '250m', memoryRequest: '128Mi' },
          },
        },
      }),
      clientCtx,
    );
    expect(r.issues.find((i) => i.code === 'CPU_LIMIT_BELOW_REQUEST')).toBeDefined();
  });
  it('rejects memoryLimit < memoryRequest', () => {
    const r = validateCustomSpec(
      spec({
        services: {
          web: {
            resources: { cpuRequest: '100m', memoryRequest: '512Mi', memoryLimit: '256Mi' },
          },
        },
      }),
      clientCtx,
    );
    expect(r.issues.find((i) => i.code === 'MEMORY_LIMIT_BELOW_REQUEST')).toBeDefined();
  });
  it('accepts limit equal to request', () => {
    const r = validateCustomSpec(
      spec({
        services: {
          web: {
            resources: { cpuRequest: '250m', cpuLimit: '250m', memoryRequest: '256Mi', memoryLimit: '256Mi' },
          },
        },
      }),
      clientCtx,
    );
    expect(r.ok).toBe(true);
  });
  it('compares units correctly (1 cpu vs 500m)', () => {
    const r = validateCustomSpec(
      spec({
        services: {
          web: {
            resources: { cpuRequest: '1', cpuLimit: '500m', memoryRequest: '128Mi' },
          },
        },
      }),
      clientCtx,
    );
    expect(r.issues.find((i) => i.code === 'CPU_LIMIT_BELOW_REQUEST')).toBeDefined();
  });
});

describe('validateCustomSpec — Service-name length cap', () => {
  // Service.metadata.name is `{deployment}-{port}` and k8s rejects
  // names > 63 chars. Port names cap at 15 chars (PORT_NAME_RE), so
  // the deployment-name cap is 47 chars whenever any port is
  // exposed via a Service.
  it('rejects a 48-char deployment name when ports are exposed', () => {
    const longName = 'a' + 'b'.repeat(47); // 48 chars
    const r = validateCustomSpec(
      spec({
        services: {
          web: {
            ports: [{ containerPort: 80, name: 'http', protocol: 'TCP', exposeAsService: true, ingressEligible: false }],
          },
        },
      }),
      { ...clientCtx, deploymentName: longName },
    );
    expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.code === 'DEPLOYMENT_NAME_TOO_LONG_FOR_SERVICE')).toBeDefined();
  });
  it('accepts a 47-char deployment name with ports', () => {
    const okName = 'a' + 'b'.repeat(46); // 47 chars
    const r = validateCustomSpec(
      spec({
        services: {
          web: {
            ports: [{ containerPort: 80, name: 'http', protocol: 'TCP', exposeAsService: true, ingressEligible: false }],
          },
        },
      }),
      { ...clientCtx, deploymentName: okName },
    );
    expect(r.issues.find((i) => i.code === 'DEPLOYMENT_NAME_TOO_LONG_FOR_SERVICE')).toBeUndefined();
  });
  it('allows long names when NO ports are exposed (no Service created)', () => {
    const longName = 'a' + 'b'.repeat(60); // 61 chars, no ports
    const r = validateCustomSpec(
      spec({ services: { web: { ports: [] } } }),
      { ...clientCtx, deploymentName: longName },
    );
    expect(r.issues.find((i) => i.code === 'DEPLOYMENT_NAME_TOO_LONG_FOR_SERVICE')).toBeUndefined();
  });
  it('skips the check when deploymentName is not passed (editor preview)', () => {
    const r = validateCustomSpec(
      spec({
        services: {
          web: {
            ports: [{ containerPort: 80, name: 'http', protocol: 'TCP', exposeAsService: true, ingressEligible: false }],
          },
        },
      }),
      clientCtx,
    );
    expect(r.issues.find((i) => i.code === 'DEPLOYMENT_NAME_TOO_LONG_FOR_SERVICE')).toBeUndefined();
  });
});

describe('validateCustomSpec — unpinned tag advisory', () => {
  it('warns on :latest', () => {
    const r = validateCustomSpec(
      spec({ services: { web: { image: 'nginx:latest' } } }),
      clientCtx,
    );
    expect(r.ok).toBe(true); // warning, not error
    expect(r.issues.find((i) => i.code === 'UNPINNED_TAG_ADVISORY')).toBeDefined();
  });
  it('warns on missing tag', () => {
    const r = validateCustomSpec(
      spec({ services: { web: { image: 'nginx' } } }),
      clientCtx,
    );
    expect(r.issues.find((i) => i.code === 'UNPINNED_TAG_ADVISORY')).toBeDefined();
  });
  it('suppresses warning when operator disabled it', () => {
    const r = validateCustomSpec(
      spec({ services: { web: { image: 'nginx:latest' } } }),
      { ...clientCtx, warnUnpinnedTags: false },
    );
    expect(r.issues.find((i) => i.code === 'UNPINNED_TAG_ADVISORY')).toBeUndefined();
  });
  it('does not warn on a digest-pinned image', () => {
    const r = validateCustomSpec(
      spec({ services: { web: { image: `nginx@sha256:${'a'.repeat(64)}` } } }),
      clientCtx,
    );
    expect(r.issues.find((i) => i.code === 'UNPINNED_TAG_ADVISORY')).toBeUndefined();
  });
});
