import * as yaml from 'js-yaml';
import { eq, inArray } from 'drizzle-orm';
import { clients, hostingPlans, domains, deployments, catalogEntries } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { getDefaultStorageClass } from '../storage-settings/service.js';
import { getClusterIssuerName, isAutoTlsEnabled } from '../tls-settings/service.js';
import { domainToSecretName } from '../ssl-certs/cert-manager.js';
// SYSTEM_CPU_RESERVE / SYSTEM_MEMORY_RESERVE removed — quota is now
// plan-exact and file-manager is exempt via priorityClassName.
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
  //    Labels mirror what `applyNamespace()` in k8s-provisioner sets at
  //    runtime, including the PSS `enforce/warn/audit` triplet
  //    introduced by ADR-036. The downloadable manifest bundle MUST
  //    keep these in lock-step — an operator who re-applies the
  //    generated YAML to restore a namespace would otherwise drop the
  //    PSS enforcement labels and silently weaken tenant isolation.
  manifests.push(buildManifest('namespace.yaml', {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: namespace,
      labels: {
        platform: 'k8s-hosting',
        client: clientId,
        'pod-security.kubernetes.io/enforce': 'baseline',
        'pod-security.kubernetes.io/enforce-version': 'latest',
        'pod-security.kubernetes.io/warn': 'restricted',
        'pod-security.kubernetes.io/warn-version': 'latest',
        'pod-security.kubernetes.io/audit': 'restricted',
        'pod-security.kubernetes.io/audit-version': 'latest',
      },
    },
  }));

  // 2. ResourceQuotas — split into Pod-scoped (cpu/memory, counts only
  //    tenant-default Pods → file-manager + snapshot/restore Pods are
  //    exempt via priorityClassName=platform-tenant-overhead) and
  //    storage-only (unscoped, namespace-wide PVC budget). K8s rejects
  //    requests.storage under a PriorityClass scope with HTTP 422
  //    "unsupported scope applied to resource", so they MUST be
  //    separate quotas. Plan-exact limits (no SYSTEM_*_RESERVE padding).
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
      },
      scopeSelector: {
        matchExpressions: [
          {
            scopeName: 'PriorityClass',
            operator: 'In',
            values: ['tenant-default'],
          },
        ],
      },
    },
  }));

  manifests.push(buildManifest('resource-quota-storage.yaml', {
    apiVersion: 'v1',
    kind: 'ResourceQuota',
    metadata: {
      name: `${namespace}-storage-quota`,
      namespace,
    },
    spec: {
      hard: {
        'requests.storage': `${storageLimit}Gi`,
      },
    },
  }));

  // 3. NetworkPolicy — deny all ingress except from the traefik
  //    controller namespace. Phase 0 of the Traefik migration replaced
  //    ingress-nginx with Traefik; the namespace name flipped from
  //    `ingress-nginx` to `traefik`.
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
                  'kubernetes.io/metadata.name': 'traefik',
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
    // Custom deployments (ADR-036) render via the custom-deployments
    // module in PR-2, not the catalog-manifests path. Skip them here.
    if (deployment.catalogEntryId === null) continue;
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

  // 6. IngressRoute (one per client, one route per domain).
  // The Traefik migration removed the per-Ingress cert-manager annotation
  // (the Ingress shim doesn't process IngressRoute CRDs) in favour of
  // an explicit Certificate CR alongside the IngressRoute.
  if (clientDomains.length > 0) {
    const deploymentMap = new Map<string, string>();
    for (const d of clientDeployments) {
      deploymentMap.set(d.id, d.name);
    }

    const routes = clientDomains.map((domain) => {
      const serviceName = domain.deploymentId
        ? (deploymentMap.get(domain.deploymentId) ?? clientDeployments[0]?.name ?? 'default')
        : (clientDeployments[0]?.name ?? 'default');
      return {
        match: `Host(\`${domain.domainName}\`)`,
        kind: 'Rule',
        services: [{ name: serviceName, port: 80 }],
      };
    });

    const autoTls = await isAutoTlsEnabled(db);
    const primarySecret = autoTls && clientDomains[0]
      ? domainToSecretName(clientDomains[0].domainName)
      : null;

    manifests.push(buildManifest('ingressroute.yaml', {
      apiVersion: 'traefik.io/v1alpha1',
      kind: 'IngressRoute',
      metadata: {
        name: `${namespace}-ingress`,
        namespace,
      },
      spec: {
        entryPoints: ['websecure'],
        routes,
        ...(primarySecret ? { tls: { secretName: primarySecret } } : {}),
      },
    }));

    // Pair each domain with an explicit cert-manager Certificate CR.
    // Traefik's TLSStore is keyed by SNI hostname, so a Certificate per
    // domain still resolves correctly at request time (the IngressRoute
    // only needs to reference one primary secret to register the host).
    if (autoTls) {
      const clusterIssuer = await getClusterIssuerName(db);
      for (const domain of clientDomains) {
        manifests.push(buildManifest(`certificate-${domain.domainName.replace(/\./g, '-')}.yaml`, {
          apiVersion: 'cert-manager.io/v1',
          kind: 'Certificate',
          metadata: {
            name: domain.domainName.replace(/\./g, '-'),
            namespace,
          },
          spec: {
            secretName: domainToSecretName(domain.domainName),
            duration: '2160h',
            renewBefore: '720h',
            privateKey: {
              algorithm: 'ECDSA',
              size: 256,
              rotationPolicy: 'Always',
            },
            usages: ['digital signature', 'key encipherment', 'server auth'],
            dnsNames: [domain.domainName],
            issuerRef: {
              name: clusterIssuer,
              kind: 'ClusterIssuer',
              group: 'cert-manager.io',
            },
          },
        }));
      }
    }
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
