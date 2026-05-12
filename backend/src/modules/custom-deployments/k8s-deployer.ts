// Renders a normalized CustomDeploymentSpec into k8s resources.
//
// PR-2 simple-mode scope: exactly ONE service per spec. Compose
// multi-service support lands in PR-3 with the compose parser; the
// `multiService` parameter exists today as a guard rail (`false` →
// reject specs with >1 service before we touch the cluster).
//
// We deliberately do NOT route through `deployments/k8s-deployer.ts`
// (the catalog deployer). The catalog code path has many features
// that don't apply to custom (catalog-token env expansion,
// password-reset init containers, firewall annotations, host ports);
// folding optional flags into that surface would either weaken
// catalog assumptions or end up unused. This module renders the
// strict subset of k8s primitives the tenant spec maps to:
//
//   - One Deployment (replicas, container, securityContext,
//     imagePullSecrets, volumes, init-dirs initContainer)
//   - N Services for ports with exposeAsService: true
//   - 0..N ConfigMaps for spec.configMaps (per-deployment)
//   - 0..N Secrets   for spec.secrets    (per-deployment)
//
// Storage layout (matches catalog convention):
//   PVC: `{namespace}-storage`   (shared tenant PVC)
//   Mount name: `client-storage`
//   subPath per volume: `custom/{deploymentName}/{volumeName}`
//
// Re-apply semantics: createOrReplace per resource. Idempotent.

import { STRATEGIC_MERGE_PATCH } from '../../shared/k8s-patch.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { k8sPullSecretName } from './pat-store.js';
import type {
  CustomDeploymentSpec,
  CustomDeploymentService,
} from './schema.js';

const CLIENT_PVC_VOLUME_NAME = 'client-storage';

/**
 * Platform-reserved label-key prefix. Tenants cannot stamp labels
 * starting with this prefix on their pods; the deployer strips them
 * before applying the manifest. Protects forensic queries
 * (`platform.phoenix-host.net/deployment-id`, etc.) from being
 * shadowed by tenant-controlled values once compose YAML (PR-3)
 * lets a tenant supply arbitrary labels.
 */
const RESERVED_LABEL_PREFIX = 'platform.phoenix-host.net/';

function filterServiceLabels(raw: Record<string, string> | undefined): Record<string, string> {
  if (!raw) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(([k]) => !k.startsWith(RESERVED_LABEL_PREFIX)),
  );
}

export interface DeployCustomInput {
  readonly deploymentId: string;
  readonly deploymentName: string;
  readonly namespace: string;
  /** Per-deployment subPath root on the tenant's shared PVC. Defaults
   *  to `custom/{deploymentName}`. Phase 1 always uses this default. */
  readonly storageSubPath: string;
  readonly spec: CustomDeploymentSpec;
  /** When true the deployment uses the per-deployment image-pull
   *  Secret (`image-pull-{deploymentId}`). Material is materialised
   *  separately via pat-store.materializePullSecret. */
  readonly hasPullCredential: boolean;
  /** When provided, used for hard nodeSelector pin (local tier) or
   *  soft preferredAffinity (HA tier) — matching the catalog
   *  deployer's behaviour for tenant pod placement. */
  readonly workerNodeName?: string | null;
  readonly storageTier?: 'local' | 'ha' | null;
}

const TENANT_DEFAULT_PRIORITY_CLASS = 'tenant-default';
const INIT_DIRS_IMAGE = 'busybox:1.37-musl';

// ─── Top-level deploy ───────────────────────────────────────────────────────

export async function deployCustomDeployment(
  k8s: K8sClients,
  input: DeployCustomInput,
): Promise<void> {
  // Phase 1: simple mode guarantees exactly one service. The compose
  // parser (PR-3) constructs multi-service specs.
  const serviceEntries = Object.entries(input.spec.services);
  if (serviceEntries.length !== 1) {
    throw new Error(
      `custom k8s-deployer: simple-mode requires exactly one service, got ${serviceEntries.length}`,
    );
  }
  const [serviceName, service] = serviceEntries[0];

  // 1. ConfigMaps + Secrets first — Pod refs may reference them.
  for (const cm of input.spec.configMaps) {
    await applyConfigMap(k8s, input, cm);
  }
  for (const s of input.spec.secrets) {
    await applySecret(k8s, input, s);
  }

  // 2. Deployment.
  await applyDeployment(k8s, input, serviceName, service);

  // 3. Services (one per `exposeAsService: true` port).
  for (const port of service.ports) {
    if (!port.exposeAsService) continue;
    await applyService(k8s, input, serviceName, port);
  }
}

// ─── ConfigMap / Secret renderers ───────────────────────────────────────────

/**
 * Wrap a raw k8s SDK error so the original message — which can
 * include parts of the request payload (e.g. a tenant's inline
 * Secret content on a PATCH 422 echo) — never reaches the caller's
 * `lastError` field on the deployment row.
 */
function wrapK8sDeployerError(_err: unknown, kind: string, name: string, op: 'create' | 'patch'): Error {
  return new Error(`Failed to ${op} ${kind} '${name}' to cluster`);
}

async function applyConfigMap(
  k8s: K8sClients,
  input: DeployCustomInput,
  cm: CustomDeploymentSpec['configMaps'][number],
): Promise<void> {
  const name = renderConfigMapName(input.deploymentId, cm.name);
  const body = {
    metadata: { name, namespace: input.namespace, labels: ownerLabels(input) },
    data: { content: cm.content },
  };
  try {
    await k8s.core.createNamespacedConfigMap({ namespace: input.namespace, body });
  } catch (err) {
    if (!isK8s409(err)) throw wrapK8sDeployerError(err, 'ConfigMap', name, 'create');
    try {
      await k8s.core.patchNamespacedConfigMap(
        { name, namespace: input.namespace, body: { data: body.data } } as unknown as Parameters<typeof k8s.core.patchNamespacedConfigMap>[0],
        STRATEGIC_MERGE_PATCH,
      );
    } catch (patchErr) {
      throw wrapK8sDeployerError(patchErr, 'ConfigMap', name, 'patch');
    }
  }
}

async function applySecret(
  k8s: K8sClients,
  input: DeployCustomInput,
  s: CustomDeploymentSpec['secrets'][number],
): Promise<void> {
  const name = renderSecretName(input.deploymentId, s.name);
  const body = {
    metadata: { name, namespace: input.namespace, labels: ownerLabels(input) },
    type: 'Opaque',
    data: { content: Buffer.from(s.content, 'utf8').toString('base64') },
  };
  try {
    await k8s.core.createNamespacedSecret({ namespace: input.namespace, body });
  } catch (err) {
    if (!isK8s409(err)) throw wrapK8sDeployerError(err, 'Secret', name, 'create');
    try {
      await k8s.core.patchNamespacedSecret(
        { name, namespace: input.namespace, body: { data: body.data } } as unknown as Parameters<typeof k8s.core.patchNamespacedSecret>[0],
        STRATEGIC_MERGE_PATCH,
      );
    } catch (patchErr) {
      throw wrapK8sDeployerError(patchErr, 'Secret', name, 'patch');
    }
  }
}

// ─── Deployment renderer ────────────────────────────────────────────────────

async function applyDeployment(
  k8s: K8sClients,
  input: DeployCustomInput,
  serviceName: string,
  service: CustomDeploymentService,
): Promise<void> {
  const name = input.deploymentName;
  const labels = {
    app: input.deploymentName,
    'platform.phoenix-host.net/deployment-id': input.deploymentId,
    'platform.phoenix-host.net/owner': 'custom-deployments',
  };
  const selectorLabels = { app: input.deploymentName };

  const container = buildContainer(serviceName, service, input);
  const podVolumes = buildPodVolumes(input.spec, input);
  const initDirs = buildInitDirsContainer(input);

  const podSpec: Record<string, unknown> = {
    containers: [container],
    priorityClassName: TENANT_DEFAULT_PRIORITY_CLASS,
    securityContext: buildPodSecurityContext(service, input.spec),
    restartPolicy: service.restartPolicy === 'Never' ? 'Never' : 'Always',
    ...(initDirs ? { initContainers: [initDirs] } : {}),
    ...(podVolumes.length > 0 ? { volumes: podVolumes } : {}),
    ...(input.hasPullCredential
      ? { imagePullSecrets: [{ name: k8sPullSecretName(input.deploymentId) }] }
      : {}),
    ...(service.stopGracePeriodSeconds !== undefined
      ? { terminationGracePeriodSeconds: service.stopGracePeriodSeconds }
      : {}),
  };

  if (input.workerNodeName) {
    if (input.storageTier === 'ha') {
      podSpec.affinity = {
        nodeAffinity: {
          preferredDuringSchedulingIgnoredDuringExecution: [{
            weight: 100,
            preference: {
              matchExpressions: [{
                key: 'kubernetes.io/hostname',
                operator: 'In',
                values: [input.workerNodeName],
              }],
            },
          }],
        },
      };
    } else {
      podSpec.nodeSelector = { 'kubernetes.io/hostname': input.workerNodeName };
    }
  }

  const body = {
    metadata: { name, namespace: input.namespace, labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: selectorLabels },
      // Recreate (not RollingUpdate). Tenant workloads pin a Longhorn
      // RWO PVC; RollingUpdate would deadlock at Multi-Attach.
      strategy: { type: 'Recreate' },
      template: {
        metadata: { labels: { ...labels, ...filterServiceLabels(service.labels) } },
        spec: podSpec,
      },
    },
  };

  try {
    await k8s.apps.createNamespacedDeployment({
      namespace: input.namespace,
      body,
    } as unknown as Parameters<typeof k8s.apps.createNamespacedDeployment>[0]);
  } catch (err) {
    if (!isK8s409(err)) throw err;
    // Patch the existing Deployment in place. Strategic-merge replaces
    // the `template` block as a unit so changes to image / env / etc.
    // propagate cleanly.
    await k8s.apps.patchNamespacedDeployment(
      { name, namespace: input.namespace, body } as unknown as Parameters<typeof k8s.apps.patchNamespacedDeployment>[0],
      STRATEGIC_MERGE_PATCH,
    );
  }
}

// ─── Container assembly ─────────────────────────────────────────────────────

function buildContainer(
  serviceName: string,
  service: CustomDeploymentService,
  input: DeployCustomInput,
): Record<string, unknown> {
  const env = buildContainerEnv(service, input);
  const volumeMounts = buildVolumeMounts(service, input);
  const ports = service.ports.map((p) => ({
    containerPort: p.containerPort,
    name: p.name,
    protocol: p.protocol,
  }));
  // CPU/memory limits: explicit when set, else default to 2× request
  // (CPU) and 1.5× request (memory). This is stricter than catalog
  // (which sets limits === requests for every container) — custom
  // deployments need limits to protect against runaway processes from
  // tenant-supplied images.
  const cpuLimit = service.resources.cpuLimit ?? defaultCpuLimit(service.resources.cpuRequest);
  const memLimit = service.resources.memoryLimit ?? defaultMemoryLimit(service.resources.memoryRequest);

  // Compose's `entrypoint:` → k8s `command` (k8s docs call it "Entrypoint Array").
  // Compose's `command:`    → k8s `args`    (k8s docs call it "Cmd Array").
  // The custom-deployments schema uses the docker terms; map them to
  // k8s names here.
  const k8sCommand = service.entrypoint && service.entrypoint.length > 0 ? service.entrypoint : undefined;
  const k8sArgs = service.command && service.command.length > 0 ? service.command : undefined;

  return {
    name: serviceName,
    image: service.image,
    imagePullPolicy: 'Always',
    ...(k8sCommand ? { command: k8sCommand } : {}),
    ...(k8sArgs ? { args: k8sArgs } : {}),
    ...(ports.length > 0 ? { ports } : {}),
    ...(env.length > 0 ? { env } : {}),
    ...(volumeMounts.length > 0 ? { volumeMounts } : {}),
    resources: {
      requests: {
        cpu: service.resources.cpuRequest,
        memory: service.resources.memoryRequest,
      },
      limits: { cpu: cpuLimit, memory: memLimit },
    },
    securityContext: buildContainerSecurityContext(service, input.spec),
    ...(service.workingDir ? { workingDir: service.workingDir } : {}),
  };
}

function buildContainerEnv(
  service: CustomDeploymentService,
  input: DeployCustomInput,
): Array<Record<string, unknown>> {
  return service.env.map((e) => {
    if (e.value !== undefined) return { name: e.name, value: e.value };
    if (e.valueFromSecret) {
      return {
        name: e.name,
        valueFrom: {
          secretKeyRef: {
            name: renderSecretName(input.deploymentId, e.valueFromSecret),
            key: 'content',
          },
        },
      };
    }
    if (e.valueFromConfigMap) {
      return {
        name: e.name,
        valueFrom: {
          configMapKeyRef: {
            name: renderConfigMapName(input.deploymentId, e.valueFromConfigMap),
            key: 'content',
          },
        },
      };
    }
    // Validator rejects this; keep an explicit guard so a stray
    // unvalidated path produces a clear error rather than a silent
    // dropped env var.
    throw new Error(`env var '${e.name}' has no value source`);
  });
}

function buildVolumeMounts(
  service: CustomDeploymentService,
  input: DeployCustomInput,
): Array<Record<string, unknown>> {
  const mounts: Array<Record<string, unknown>> = [];

  for (const vm of service.volumeMounts) {
    mounts.push({
      name: CLIENT_PVC_VOLUME_NAME,
      mountPath: vm.containerPath,
      subPath: `${input.storageSubPath}/${vm.name}`,
      ...(vm.readOnly ? { readOnly: true } : {}),
    });
  }

  // ConfigMap mounts via projected volumes are out of scope Phase 1;
  // the tenant references configMaps via `valueFromConfigMap` env
  // refs only. Same for Secrets.

  for (const t of service.tmpfs) {
    mounts.push({
      name: tmpfsVolumeName(t.path),
      mountPath: t.path,
    });
  }

  return mounts;
}

function buildPodVolumes(
  spec: CustomDeploymentSpec,
  input: DeployCustomInput,
): Array<Record<string, unknown>> {
  const volumes: Array<Record<string, unknown>> = [];

  // 1. Tenant PVC (only when at least one named volume exists).
  const usedNamedVolumes = Object.values(spec.services)
    .flatMap((svc) => svc.volumeMounts.map((vm) => vm.name));
  const hasNamedVolumes = usedNamedVolumes.length > 0;
  if (hasNamedVolumes) {
    volumes.push({
      name: CLIENT_PVC_VOLUME_NAME,
      persistentVolumeClaim: { claimName: `${input.namespace}-storage` },
    });
  }

  // 2. Tmpfs emptyDirs.
  const tmpfsSeen = new Set<string>();
  for (const svc of Object.values(spec.services)) {
    for (const t of svc.tmpfs) {
      const name = tmpfsVolumeName(t.path);
      if (tmpfsSeen.has(name)) continue;
      tmpfsSeen.add(name);
      volumes.push({
        name,
        emptyDir: { medium: 'Memory', sizeLimit: `${t.sizeMi}Mi` },
      });
    }
  }

  return volumes;
}

function buildInitDirsContainer(input: DeployCustomInput): Record<string, unknown> | null {
  // Pre-create each named volume's subPath on the PVC. Mirrors the
  // catalog deployer pattern (chmod 777 so any image's runtime user
  // can write on first boot).
  const namedVolumes = Object.keys(input.spec.volumes);
  if (namedVolumes.length === 0) return null;

  const mkdirParts = namedVolumes.map((volName) => {
    const path = `/data/${input.storageSubPath}/${volName}`;
    return `mkdir -p '${path}' && chmod 777 '${path}'`;
  });
  return {
    name: 'init-dirs',
    image: INIT_DIRS_IMAGE,
    command: ['sh', '-c', mkdirParts.join(' && ')],
    volumeMounts: [{ name: CLIENT_PVC_VOLUME_NAME, mountPath: '/data' }],
    resources: {
      requests: { cpu: '10m', memory: '16Mi' },
      limits: { cpu: '50m', memory: '32Mi' },
    },
  };
}

// ─── Service renderer ───────────────────────────────────────────────────────

async function applyService(
  k8s: K8sClients,
  input: DeployCustomInput,
  serviceName: string,
  port: CustomDeploymentService['ports'][number],
): Promise<void> {
  const name = `${input.deploymentName}-${port.name}`;
  const labels = {
    app: input.deploymentName,
    'platform.phoenix-host.net/deployment-id': input.deploymentId,
    'platform.phoenix-host.net/owner': 'custom-deployments',
    ...(port.ingressEligible ? { 'platform.phoenix-host.net/ingress-eligible': 'true' } : {}),
  };
  const body = {
    metadata: { name, namespace: input.namespace, labels },
    spec: {
      type: 'ClusterIP',
      selector: { app: input.deploymentName },
      ports: [{
        port: port.containerPort,
        targetPort: port.containerPort,
        protocol: port.protocol,
        name: port.name,
      }],
    },
  };
  try {
    await k8s.core.createNamespacedService({ namespace: input.namespace, body });
  } catch (err) {
    if (!isK8s409(err)) throw err;
    // For Services, immutable fields (clusterIP, selector under some
    // conditions) make strategic-merge brittle. We do a narrow patch
    // of `spec.ports` only — that's the field tenants change most
    // when iterating. Selector + clusterIP stay stable.
    await k8s.core.patchNamespacedService(
      { name, namespace: input.namespace, body: { spec: { ports: body.spec.ports } } } as unknown as Parameters<typeof k8s.core.patchNamespacedService>[0],
      STRATEGIC_MERGE_PATCH,
    );
  }
}

// ─── Security context ───────────────────────────────────────────────────────

function buildPodSecurityContext(
  service: CustomDeploymentService,
  _spec: CustomDeploymentSpec,
): Record<string, unknown> {
  const ctx: Record<string, unknown> = {
    seccompProfile: { type: 'RuntimeDefault' },
  };
  // runAsNonRoot at the Pod level is the strongest guarantee. We
  // tie suppression strictly to the service's OWN declared uid/gid
  // — an `allowRoot` deployment does NOT blanket-permit root for
  // every service. Each service that wants root has to declare
  // `runAsUser: 0` (or runAsGroup: 0) explicitly, which the validator
  // gates separately on the admin-only allowRoot flag.
  const wantsRoot = service.runAsUser === 0 || service.runAsGroup === 0;
  if (!wantsRoot) {
    ctx.runAsNonRoot = true;
  }
  if (service.runAsUser !== undefined) ctx.runAsUser = service.runAsUser;
  if (service.runAsGroup !== undefined) ctx.runAsGroup = service.runAsGroup;
  return ctx;
}

function buildContainerSecurityContext(
  service: CustomDeploymentService,
  _spec: CustomDeploymentSpec,
): Record<string, unknown> {
  // PSS-baseline requires `allowPrivilegeEscalation: false` and
  // `capabilities.drop: [ALL]`. We set both unconditionally — any
  // tenant image that needs them will fail at admission with a
  // crisp error (which the validator's deny-list already prevents).
  const ctx: Record<string, unknown> = {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ['ALL'] },
    readOnlyRootFilesystem: service.readOnlyRootFilesystem,
  };
  // PSS baseline does NOT forbid root by itself; PSS restricted does.
  // The validator gates `runAsUser:0` on the admin-only `allowRoot`
  // flag, so here we just propagate what the spec asked for.
  if (service.runAsUser !== undefined) ctx.runAsUser = service.runAsUser;
  if (service.runAsGroup !== undefined) ctx.runAsGroup = service.runAsGroup;
  return ctx;
}

// ─── Resource defaults ──────────────────────────────────────────────────────

function defaultCpuLimit(request: string): string {
  // 2× request, rounded to the nearest millicpu.
  const m = /^([0-9]+(?:\.[0-9]+)?)(m)?$/.exec(request);
  if (!m) return request;
  const n = parseFloat(m[1]);
  const isM = m[2] === 'm';
  const millis = Math.round((isM ? n : n * 1000) * 2);
  return `${millis}m`;
}

function defaultMemoryLimit(request: string): string {
  // 1.5× request, preserving the unit.
  const m = /^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti|k|M|G|T)?$/.exec(request);
  if (!m) return request;
  const n = parseFloat(m[1]);
  const unit = m[2] ?? '';
  return `${Math.round(n * 1.5)}${unit}`;
}

// ─── helpers ────────────────────────────────────────────────────────────────

export function renderConfigMapName(deploymentId: string, key: string): string {
  return `cd-${deploymentId}-cfg-${key}`;
}

export function renderSecretName(deploymentId: string, key: string): string {
  return `cd-${deploymentId}-sec-${key}`;
}

function tmpfsVolumeName(path: string): string {
  // Build a DNS-safe name from the tmpfs mount path. Replace `/`
  // with `-`, lowercase, prepend `tmpfs-`. The result is unique per
  // path within a pod.
  return 'tmpfs-' + path.replace(/^\//, '').replace(/[^a-z0-9-]+/gi, '-').toLowerCase().slice(0, 50);
}

function ownerLabels(input: DeployCustomInput): Record<string, string> {
  return {
    'platform.phoenix-host.net/deployment-id': input.deploymentId,
    'platform.phoenix-host.net/owner': 'custom-deployments',
  };
}

function isK8s409(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('HTTP-Code: 409')) return true;
  return (err as { statusCode?: number }).statusCode === 409;
}

/**
 * Delete the Deployment + Services + ConfigMaps + Secrets owned by a
 * custom deployment. Uses the label selector
 * `platform.phoenix-host.net/deployment-id=<id>` so we don't have to
 * know the exact list of resources at delete time. Idempotent.
 */
export async function deleteCustomDeployment(
  k8s: K8sClients,
  namespace: string,
  deploymentId: string,
  deploymentName: string,
): Promise<void> {
  const selector = `platform.phoenix-host.net/deployment-id=${deploymentId}`;

  // Deployment by name (faster than label-listing).
  try {
    await k8s.apps.deleteNamespacedDeployment({ name: deploymentName, namespace });
  } catch (err) {
    if (!isK8s404(err)) throw err;
  }

  // Services / ConfigMaps / Secrets by label. Listing returns
  // exactly the per-deployment cohort because the deployer stamps
  // the owner label on every resource it creates.
  await deleteByLabel(k8s, namespace, selector, 'service');
  await deleteByLabel(k8s, namespace, selector, 'configmap');
  await deleteByLabel(k8s, namespace, selector, 'secret');
}

async function deleteByLabel(
  k8s: K8sClients,
  namespace: string,
  labelSelector: string,
  kind: 'service' | 'configmap' | 'secret',
): Promise<void> {
  switch (kind) {
    case 'service': {
      const list = await k8s.core.listNamespacedService({ namespace, labelSelector } as Parameters<typeof k8s.core.listNamespacedService>[0]) as unknown as { items: Array<{ metadata?: { name?: string } }> };
      for (const item of list.items ?? []) {
        const n = item.metadata?.name;
        if (n) await k8s.core.deleteNamespacedService({ name: n, namespace }).catch(swallow404);
      }
      return;
    }
    case 'configmap': {
      const list = await k8s.core.listNamespacedConfigMap({ namespace, labelSelector } as Parameters<typeof k8s.core.listNamespacedConfigMap>[0]) as unknown as { items: Array<{ metadata?: { name?: string } }> };
      for (const item of list.items ?? []) {
        const n = item.metadata?.name;
        if (n) await k8s.core.deleteNamespacedConfigMap({ name: n, namespace }).catch(swallow404);
      }
      return;
    }
    case 'secret': {
      const list = await k8s.core.listNamespacedSecret({ namespace, labelSelector } as Parameters<typeof k8s.core.listNamespacedSecret>[0]) as unknown as { items: Array<{ metadata?: { name?: string } }> };
      for (const item of list.items ?? []) {
        const n = item.metadata?.name;
        if (n) await k8s.core.deleteNamespacedSecret({ name: n, namespace }).catch(swallow404);
      }
      return;
    }
  }
}

function swallow404(err: unknown): void {
  if (!isK8s404(err)) throw err;
}

function isK8s404(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('HTTP-Code: 404')) return true;
  return (err as { statusCode?: number }).statusCode === 404;
}
