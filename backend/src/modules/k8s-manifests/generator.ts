import * as yaml from 'js-yaml';
import { eq, inArray } from 'drizzle-orm';
import { clients, hostingPlans, domains, deployments, catalogEntries } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { getDefaultStorageClass } from '../storage-settings/service.js';
import { getClusterIssuerName, isAutoTlsEnabled } from '../tls-settings/service.js';
import { domainToSecretName } from '../ssl-certs/cert-manager.js';
import { SYSTEM_CPU_RESERVE, SYSTEM_MEMORY_RESERVE } from '../k8s-provisioner/service.js';
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

  // Fetch deployments for this client
  const clientDeployments = await db.select().from(deployments).where(eq(deployments.clientId, clientId)) as Array<typeof deployments.$inferSelect>;

  // Fetch catalog entries for deployments
  const entryIds = clientDeployments
    .map(d => d.catalogEntryId)
    .filter((id): id is string => id !== null);

  const entryMap = new Map<string, typeof catalogEntries.$inferSelect>();
  if (entryIds.length > 0) {
    const allEntries = await db.select().from(catalogEntries).where(inArray(catalogEntries.id, entryIds)) as Array<typeof catalogEntries.$inferSelect>;
    for (const entry of allEntries) {
      entryMap.set(entry.id, entry);
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

  // 2. ResourceQuota (includes system service headroom for file-manager)
  const totalCpu = (parseFloat(cpuLimit) + SYSTEM_CPU_RESERVE).toFixed(2);
  const totalMemoryGi = (parseFloat(memoryLimit) + SYSTEM_MEMORY_RESERVE).toFixed(2);

  manifests.push(buildManifest('resource-quota.yaml', {
    apiVersion: 'v1',
    kind: 'ResourceQuota',
    metadata: {
      name: `${namespace}-quota`,
      namespace,
    },
    spec: {
      hard: {
        'limits.cpu': totalCpu,
        'limits.memory': `${totalMemoryGi}Gi`,
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

  // 5. Deployments + Services (one per deployment)
  for (const deployment of clientDeployments) {
    const entry = entryMap.get(deployment.catalogEntryId);

    // Resolve container image from catalog entry components or fallback
    const primaryComponent = entry?.components?.[0];
    const containerImage = primaryComponent?.image ?? entry?.image ?? 'nginx:1.27-alpine';
    const containerPort = primaryComponent?.ports?.[0]?.port ?? 8080;

    manifests.push(buildManifest(`deployment-${deployment.name}.yaml`, {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: deployment.name,
        namespace,
        labels: {
          app: deployment.name,
        },
      },
      spec: {
        replicas: deployment.replicaCount,
        selector: {
          matchLabels: {
            app: deployment.name,
          },
        },
        template: {
          metadata: {
            labels: {
              app: deployment.name,
            },
          },
          spec: {
            containers: [
              {
                name: deployment.name,
                image: containerImage,
                ports: [{ containerPort: containerPort }],
                resources: {
                  requests: {
                    cpu: deployment.cpuRequest,
                    memory: deployment.memoryRequest,
                  },
                },
              },
            ],
          },
        },
      },
    }));

    manifests.push(buildManifest(`service-${deployment.name}.yaml`, {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: deployment.name,
        namespace,
      },
      spec: {
        type: 'ClusterIP',
        selector: {
          app: deployment.name,
        },
        ports: [
          {
            port: 80,
            targetPort: containerPort,
          },
        ],
      },
    }));
  }

  // 6. Ingress (one per client, with rules per domain)
  if (clientDomains.length > 0) {
    // Build a map of deploymentId -> deployment name for routing
    const deploymentMap = new Map<string, string>();
    for (const d of clientDeployments) {
      deploymentMap.set(d.id, d.name);
    }

    const rules = clientDomains.map(domain => {
      const serviceName = domain.deploymentId
        ? (deploymentMap.get(domain.deploymentId) ?? clientDeployments[0]?.name ?? 'default')
        : (clientDeployments[0]?.name ?? 'default');

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

    // TLS configuration
    const autoTls = await isAutoTlsEnabled(db);
    const annotations: Record<string, string> = {};

    if (autoTls) {
      const clusterIssuer = await getClusterIssuerName(db);
      annotations['cert-manager.io/cluster-issuer'] = clusterIssuer;
    }

    const ingressSpec: Record<string, unknown> = {
      ingressClassName: 'nginx',
      rules,
    };

    if (autoTls && clientDomains.length > 0) {
      // Group domains by TLS secret (one secret per domain for individual certs)
      ingressSpec.tls = clientDomains.map(domain => ({
        hosts: [domain.domainName],
        secretName: domainToSecretName(domain.domainName),
      }));
    }

    manifests.push(buildManifest('ingress.yaml', {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: {
        name: `${namespace}-ingress`,
        namespace,
        annotations,
      },
      spec: ingressSpec,
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
