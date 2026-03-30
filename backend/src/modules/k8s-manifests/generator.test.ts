import { describe, it, expect, vi } from 'vitest';
import * as yaml from 'js-yaml';
import { generateClientManifests } from './generator.js';

// ─── Mock Data ──────────────────────────────────────────────────────────────

const mockClient = {
  id: 'client-001',
  companyName: 'Acme Corp',
  kubernetesNamespace: 'acme-corp',
  planId: 'plan-001',
  regionId: 'region-001',
  status: 'active' as const,
};

const mockPlan = {
  id: 'plan-001',
  code: 'starter',
  name: 'Starter Plan',
  cpuLimit: '2.00',
  memoryLimit: '4.00',
  storageLimit: '20.00',
  status: 'active' as const,
};

const mockDomains = [
  { id: 'd1', domainName: 'example.com', clientId: 'client-001', workloadId: 'w1', status: 'active' },
  { id: 'd2', domainName: 'blog.example.com', clientId: 'client-001', workloadId: 'w1', status: 'active' },
];

const mockWorkloads = [
  {
    id: 'w1',
    clientId: 'client-001',
    name: 'web-app',
    containerImageId: 'img-001',
    replicaCount: 2,
    cpuRequest: '250m',
    memoryRequest: '256Mi',
    status: 'running',
  },
  {
    id: 'w2',
    clientId: 'client-001',
    name: 'api-server',
    containerImageId: 'img-002',
    replicaCount: 1,
    cpuRequest: '500m',
    memoryRequest: '512Mi',
    status: 'running',
  },
];

const mockImages = [
  { id: 'img-001', code: 'wordpress', registryUrl: 'ghcr.io/hosting/wordpress:latest' },
  { id: 'img-002', code: 'node-api', registryUrl: 'ghcr.io/hosting/node-api:18' },
];

// ─── Mock DB Helper ─────────────────────────────────────────────────────────

function createMockDb(overrides: {
  client?: typeof mockClient | null;
  plan?: typeof mockPlan | null;
  domains?: typeof mockDomains;
  workloads?: typeof mockWorkloads;
  images?: typeof mockImages;
} = {}) {
  const {
    client = mockClient,
    plan = mockPlan,
    domains = mockDomains,
    workloads = mockWorkloads,
    images = mockImages,
  } = overrides;

  // Queries arrive in order: client, plan, domains, workloads, images
  const selectResults: unknown[][] = [
    client ? [client] : [],
    plan ? [plan] : [],
    domains,
    workloads,
    images,
  ];

  let selectCallIndex = 0;

  const makeChain = () => {
    const currentIdx = selectCallIndex;

    const limitFn = vi.fn().mockImplementation(() => {
      return Promise.resolve(selectResults[currentIdx] ?? []);
    });

    const whereResult = Object.assign(
      Promise.resolve(selectResults[currentIdx] ?? []),
      { limit: limitFn },
    );

    const whereFn = vi.fn().mockImplementation(() => {
      selectCallIndex++;
      return whereResult;
    });

    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    return { from: fromFn };
  };

  const selectFn = vi.fn().mockImplementation(() => makeChain());

  return { select: selectFn } as unknown as Parameters<typeof generateClientManifests>[0];
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('generateClientManifests', () => {
  it('should throw CLIENT_NOT_FOUND when client does not exist', async () => {
    const db = createMockDb({ client: null });
    await expect(generateClientManifests(db, 'nonexistent')).rejects.toThrow('not found');
  });

  it('should throw PLAN_NOT_FOUND when plan does not exist', async () => {
    const db = createMockDb({ plan: null });
    await expect(generateClientManifests(db, 'client-001')).rejects.toThrow('not found');
  });

  it('should generate namespace with correct name and labels', async () => {
    const db = createMockDb();
    const result = await generateClientManifests(db, 'client-001');

    const nsFile = result.find(f => f.filename === 'namespace.yaml');
    expect(nsFile).toBeDefined();

    const ns = yaml.load(nsFile!.content) as Record<string, unknown>;
    expect(ns).toMatchObject({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: 'acme-corp',
        labels: {
          'platform': 'k8s-hosting',
          'client': 'client-001',
        },
      },
    });
  });

  it('should generate ResourceQuota with plan limits', async () => {
    const db = createMockDb();
    const result = await generateClientManifests(db, 'client-001');

    const rqFile = result.find(f => f.filename === 'resource-quota.yaml');
    expect(rqFile).toBeDefined();

    const rq = yaml.load(rqFile!.content) as Record<string, unknown>;
    expect(rq).toMatchObject({
      apiVersion: 'v1',
      kind: 'ResourceQuota',
      metadata: {
        name: 'acme-corp-quota',
        namespace: 'acme-corp',
      },
      spec: {
        hard: {
          'limits.cpu': '2',
          'limits.memory': '4Gi',
          'requests.storage': '20Gi',
        },
      },
    });
  });

  it('should generate NetworkPolicy allowing only ingress-nginx', async () => {
    const db = createMockDb();
    const result = await generateClientManifests(db, 'client-001');

    const npFile = result.find(f => f.filename === 'network-policy.yaml');
    expect(npFile).toBeDefined();

    const np = yaml.load(npFile!.content) as Record<string, unknown>;
    expect(np).toMatchObject({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: 'default-deny-ingress',
        namespace: 'acme-corp',
      },
      spec: {
        podSelector: {},
        policyTypes: ['Ingress'],
        ingress: [
          {
            from: [
              {
                namespaceSelector: {
                  matchLabels: {
                    'kubernetes.io/metadata.name': 'ingress-nginx',
                  },
                },
              },
            ],
          },
        ],
      },
    });
  });

  it('should generate one Deployment per workload with correct image and resources', async () => {
    const db = createMockDb();
    const result = await generateClientManifests(db, 'client-001');

    const depFiles = result.filter(f => f.filename.startsWith('deployment-'));
    expect(depFiles).toHaveLength(2);

    const dep1 = yaml.load(depFiles[0].content) as Record<string, unknown>;
    expect(dep1).toMatchObject({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'web-app',
        namespace: 'acme-corp',
      },
      spec: {
        replicas: 2,
        template: {
          spec: {
            containers: [
              {
                name: 'web-app',
                image: 'ghcr.io/hosting/wordpress:latest',
                resources: {
                  requests: {
                    cpu: '250m',
                    memory: '256Mi',
                  },
                },
                ports: [{ containerPort: 8080 }],
              },
            ],
          },
        },
      },
    });

    const dep2 = yaml.load(depFiles[1].content) as Record<string, unknown>;
    expect(dep2).toMatchObject({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'api-server',
        namespace: 'acme-corp',
      },
      spec: {
        replicas: 1,
        template: {
          spec: {
            containers: [
              {
                name: 'api-server',
                image: 'ghcr.io/hosting/node-api:18',
              },
            ],
          },
        },
      },
    });
  });

  it('should generate one Service per workload (ClusterIP, 80 -> 8080)', async () => {
    const db = createMockDb();
    const result = await generateClientManifests(db, 'client-001');

    const svcFiles = result.filter(f => f.filename.startsWith('service-'));
    expect(svcFiles).toHaveLength(2);

    const svc1 = yaml.load(svcFiles[0].content) as Record<string, unknown>;
    expect(svc1).toMatchObject({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: 'web-app',
        namespace: 'acme-corp',
      },
      spec: {
        type: 'ClusterIP',
        ports: [{ port: 80, targetPort: 8080 }],
        selector: { app: 'web-app' },
      },
    });
  });

  it('should generate PVC with storage from plan', async () => {
    const db = createMockDb();
    const result = await generateClientManifests(db, 'client-001');

    const pvcFile = result.find(f => f.filename === 'pvc.yaml');
    expect(pvcFile).toBeDefined();

    const pvc = yaml.load(pvcFile!.content) as Record<string, unknown>;
    expect(pvc).toMatchObject({
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name: 'acme-corp-storage',
        namespace: 'acme-corp',
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: {
          requests: {
            storage: '20Gi',
          },
        },
      },
    });
  });

  it('should generate Ingress with domain rules', async () => {
    const db = createMockDb();
    const result = await generateClientManifests(db, 'client-001');

    const ingFile = result.find(f => f.filename === 'ingress.yaml');
    expect(ingFile).toBeDefined();

    const ing = yaml.load(ingFile!.content) as Record<string, unknown>;
    expect(ing).toMatchObject({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: {
        name: 'acme-corp-ingress',
        namespace: 'acme-corp',
        annotations: {
          'kubernetes.io/ingress.class': 'nginx',
        },
      },
      spec: {
        rules: [
          {
            host: 'example.com',
            http: {
              paths: [
                {
                  path: '/',
                  pathType: 'Prefix',
                  backend: {
                    service: { name: 'web-app', port: { number: 80 } },
                  },
                },
              ],
            },
          },
          {
            host: 'blog.example.com',
            http: {
              paths: [
                {
                  path: '/',
                  pathType: 'Prefix',
                  backend: {
                    service: { name: 'web-app', port: { number: 80 } },
                  },
                },
              ],
            },
          },
        ],
      },
    });
  });

  it('should generate kustomization.yaml listing all resource files', async () => {
    const db = createMockDb();
    const result = await generateClientManifests(db, 'client-001');

    const kustomFile = result.find(f => f.filename === 'kustomization.yaml');
    expect(kustomFile).toBeDefined();

    const kustom = yaml.load(kustomFile!.content) as Record<string, unknown>;
    expect(kustom).toMatchObject({
      apiVersion: 'kustomize.config.k8s.io/v1beta1',
      kind: 'Kustomization',
    });

    const resources = (kustom as { resources: string[] }).resources;
    expect(resources).toContain('namespace.yaml');
    expect(resources).toContain('resource-quota.yaml');
    expect(resources).toContain('network-policy.yaml');
    expect(resources).toContain('pvc.yaml');
    expect(resources).toContain('ingress.yaml');
    expect(resources).toContain('deployment-web-app.yaml');
    expect(resources).toContain('deployment-api-server.yaml');
    expect(resources).toContain('service-web-app.yaml');
    expect(resources).toContain('service-api-server.yaml');
  });

  it('should skip deployment/service when client has no workloads', async () => {
    const db = createMockDb({ workloads: [], images: [] });
    const result = await generateClientManifests(db, 'client-001');

    const depFiles = result.filter(f => f.filename.startsWith('deployment-'));
    const svcFiles = result.filter(f => f.filename.startsWith('service-'));
    expect(depFiles).toHaveLength(0);
    expect(svcFiles).toHaveLength(0);

    // Still should have namespace, quota, network policy, pvc
    expect(result.find(f => f.filename === 'namespace.yaml')).toBeDefined();
    expect(result.find(f => f.filename === 'resource-quota.yaml')).toBeDefined();
    expect(result.find(f => f.filename === 'network-policy.yaml')).toBeDefined();
    expect(result.find(f => f.filename === 'pvc.yaml')).toBeDefined();
  });

  it('should skip ingress when client has no domains', async () => {
    const db = createMockDb({ domains: [] });
    const result = await generateClientManifests(db, 'client-001');

    const ingFile = result.find(f => f.filename === 'ingress.yaml');
    expect(ingFile).toBeUndefined();

    // Kustomization should not list ingress.yaml
    const kustomFile = result.find(f => f.filename === 'kustomization.yaml');
    const kustom = yaml.load(kustomFile!.content) as { resources: string[] };
    expect(kustom.resources).not.toContain('ingress.yaml');
  });

  it('should return valid YAML strings for all manifests', async () => {
    const db = createMockDb();
    const result = await generateClientManifests(db, 'client-001');

    for (const manifest of result) {
      expect(manifest.filename).toBeTruthy();
      expect(manifest.content).toBeTruthy();
      // Should not throw when parsing
      const parsed = yaml.load(manifest.content);
      expect(parsed).toBeTruthy();
      expect(typeof parsed).toBe('object');
    }
  });

  it('should apply overrides for cpu, memory, and storage limits', async () => {
    const db = createMockDb();
    const result = await generateClientManifests(db, 'client-001', {
      overrides: {
        cpu_limit: '4',
        memory_limit: '8',
        storage_limit: '50',
      },
    });

    const rqFile = result.find(f => f.filename === 'resource-quota.yaml');
    const rq = yaml.load(rqFile!.content) as Record<string, unknown>;
    expect(rq).toMatchObject({
      spec: {
        hard: {
          'limits.cpu': '4',
          'limits.memory': '8Gi',
          'requests.storage': '50Gi',
        },
      },
    });
  });

  it('should handle workload without container image gracefully', async () => {
    const workloadNoImage = [
      {
        id: 'w1',
        clientId: 'client-001',
        name: 'static-site',
        containerImageId: null,
        replicaCount: 1,
        cpuRequest: '100m',
        memoryRequest: '128Mi',
        status: 'running',
      },
    ];
    const db = createMockDb({ workloads: workloadNoImage, images: [] });
    const result = await generateClientManifests(db, 'client-001');

    // Should still generate deployment but with a placeholder image
    const depFiles = result.filter(f => f.filename.startsWith('deployment-'));
    expect(depFiles).toHaveLength(1);

    const dep = yaml.load(depFiles[0].content) as Record<string, unknown>;
    const containers = (dep as any).spec.template.spec.containers;
    expect(containers[0].image).toBe('nginx:1.27-alpine');
  });
});
