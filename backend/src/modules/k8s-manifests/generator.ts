import * as yaml from 'js-yaml';
import { eq, inArray } from 'drizzle-orm';
import { clients, hostingPlans, domains, workloads, containerImages } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { getDefaultStorageClass } from '../storage-settings/service.js';
import type { GenerateManifestInput } from '@k8s-hosting/api-contracts';

export interface ManifestFile {
  readonly filename: string;
  readonly content: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export async function generateClientManifests(
  db: Db,
  clientId: string,
  input?: GenerateManifestInput,
): Promise<readonly ManifestFile[]> {
  // Fetch client
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client) {
    throw new ApiError('CLIENT_NOT_FOUND', `Client '${clientId}' not found`, 404, { client_id: clientId });
  }

  const typedClient = client as typeof clients.$inferSelect;

  // Fetch hosting plan
  const [plan] = await db.select().from(hostingPlans).where(eq(hostingPlans.id, typedClient.planId)).limit(1);
  if (!plan) {
    throw new ApiError('PLAN_NOT_FOUND', `Hosting plan '${typedClient.planId}' not found`, 404, { plan_id: typedClient.planId });
  }

  const typedPlan = plan as typeof hostingPlans.$inferSelect;

  // Fetch domains for this client
  const clientDomains = await db.select().from(domains).where(eq(domains.clientId, clientId)) as Array<typeof domains.$inferSelect>;

  // Fetch workloads for this client
  const clientWorkloads = await db.select().from(workloads).where(eq(workloads.clientId, clientId)) as Array<typeof workloads.$inferSelect>;

  // Fetch container images for workloads that have image IDs
  const imageIds = clientWorkloads
    .map(w => w.containerImageId)
    .filter((id): id is string => id !== null);

  const imageMap = new Map<string, typeof containerImages.$inferSelect>();
  if (imageIds.length > 0) {
    const allImages = await db.select().from(containerImages).where(inArray(containerImages.id, imageIds)) as Array<typeof containerImages.$inferSelect>;
    for (const img of allImages) {
      imageMap.set(img.id, img);
    }
  }

  const namespace = typedClient.kubernetesNamespace;
  const overrides = input?.overrides;

  // Resolve limits (overrides take precedence)
  const cpuLimit = overrides?.cpu_limit ?? String(parseFloat(typedPlan.cpuLimit));
  const memoryLimit = overrides?.memory_limit ?? String(parseFloat(typedPlan.memoryLimit));
  const storageLimit = overrides?.storage_limit ?? String(parseFloat(typedPlan.storageLimit));

  const manifests: ManifestFile[] = [];

  // 1. Namespace
  manifests.push(buildManifest('namespace.yaml', {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: namespace,
      labels: {
        platform: 'k8s-hosting',
        client: clientId,
      },
    },
  }));

  // 2. ResourceQuota
  manifests.push(buildManifest('resource-quota.yaml', {
    apiVersion: 'v1',
    kind: 'ResourceQuota',
    metadata: {
      name: `${namespace}-quota`,
      namespace,
    },
    spec: {
      hard: {
        'limits.cpu': cpuLimit,
        'limits.memory': `${memoryLimit}Gi`,
        'requests.storage': `${storageLimit}Gi`,
      },
    },
  }));

  // 3. NetworkPolicy - deny all ingress except from ingress-nginx namespace
  manifests.push(buildManifest('network-policy.yaml', {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: 'default-deny-ingress',
      namespace,
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
  }));

  // 4. PVC
  const storageClass = await getDefaultStorageClass(db);
  manifests.push(buildManifest('pvc.yaml', {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: `${namespace}-storage`,
      namespace,
    },
    spec: {
      accessModes: ['ReadWriteOnce'],
      storageClassName: storageClass,
      resources: {
        requests: {
          storage: `${storageLimit}Gi`,
        },
      },
    },
  }));

  // 5. Deployments + Services (one per workload)
  for (const workload of clientWorkloads) {
    const image = workload.containerImageId
      ? imageMap.get(workload.containerImageId)
      : undefined;

    const containerImage = image?.registryUrl ?? 'nginx:1.27-alpine';

    manifests.push(buildManifest(`deployment-${workload.name}.yaml`, {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: workload.name,
        namespace,
        labels: {
          app: workload.name,
        },
      },
      spec: {
        replicas: workload.replicaCount,
        selector: {
          matchLabels: {
            app: workload.name,
          },
        },
        template: {
          metadata: {
            labels: {
              app: workload.name,
            },
          },
          spec: {
            containers: [
              {
                name: workload.name,
                image: containerImage,
                ports: [{ containerPort: 8080 }],
                resources: {
                  requests: {
                    cpu: workload.cpuRequest,
                    memory: workload.memoryRequest,
                  },
                },
              },
            ],
          },
        },
      },
    }));

    manifests.push(buildManifest(`service-${workload.name}.yaml`, {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: workload.name,
        namespace,
      },
      spec: {
        type: 'ClusterIP',
        selector: {
          app: workload.name,
        },
        ports: [
          {
            port: 80,
            targetPort: 8080,
          },
        ],
      },
    }));
  }

  // 6. Ingress (one per client, with rules per domain)
  if (clientDomains.length > 0) {
    // Build a map of workloadId -> workload name for routing
    const workloadMap = new Map<string, string>();
    for (const w of clientWorkloads) {
      workloadMap.set(w.id, w.name);
    }

    const rules = clientDomains.map(domain => {
      const serviceName = domain.workloadId
        ? (workloadMap.get(domain.workloadId) ?? clientWorkloads[0]?.name ?? 'default')
        : (clientWorkloads[0]?.name ?? 'default');

      return {
        host: domain.domainName,
        http: {
          paths: [
            {
              path: '/',
              pathType: 'Prefix',
              backend: {
                service: {
                  name: serviceName,
                  port: { number: 80 },
                },
              },
            },
          ],
        },
      };
    });

    manifests.push(buildManifest('ingress.yaml', {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: {
        name: `${namespace}-ingress`,
        namespace,
        annotations: {
          'kubernetes.io/ingress.class': 'nginx',
        },
      },
      spec: {
        rules,
      },
    }));
  }

  // 7. kustomization.yaml
  const resourceFiles = manifests.map(m => m.filename);
  manifests.push(buildManifest('kustomization.yaml', {
    apiVersion: 'kustomize.config.k8s.io/v1beta1',
    kind: 'Kustomization',
    resources: resourceFiles,
  }));

  return manifests;
}

function buildManifest(filename: string, resource: Record<string, unknown>): ManifestFile {
  return {
    filename,
    content: yaml.dump(resource, { noRefs: true, lineWidth: -1 }),
  };
}
