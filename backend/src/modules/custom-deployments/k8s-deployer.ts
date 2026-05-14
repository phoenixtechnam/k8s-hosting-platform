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
import { isNotFound } from '../../shared/k8s-errors.js';

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
  // Multi-service supported (PR-3). The validator enforces the
  // 10-service cap and depends_on integrity; the deployer just
  // renders k8s primitives per service.
  const serviceEntries = Object.entries(input.spec.services);
  if (serviceEntries.length === 0) {
    throw new Error('custom k8s-deployer: spec has no services');
  }
  const serviceCount = serviceEntries.length;

  // 1. ConfigMaps + Secrets first — Pod refs may reference them.
  for (const cm of input.spec.configMaps) {
    await applyConfigMap(k8s, input, cm);
  }
  for (const s of input.spec.secrets) {
    await applySecret(k8s, input, s);
  }

  // 2. For each service: render Deployment + Services. Apply in a
  // stable order (insertion order from spec.services) so a redeploy
  // doesn't churn the cluster needlessly.
  for (const [serviceName, service] of serviceEntries) {
    await applyDeployment(k8s, input, serviceName, service, serviceCount);
    for (const port of service.ports) {
      if (!port.exposeAsService) continue;
      await applyService(k8s, input, serviceName, port, serviceCount);
    }
  }
}

/**
 * Deterministic k8s resource name for a service within a stack.
 * - Single service: just the deployment name (backwards-compat with
 *   PR-2 simple-mode deployments).
 * - Multi service: `{deploymentName}-{serviceName}`.
 * Matches the catalog deployer's `k8sResourceName` convention.
 */
export function serviceResourceName(
  deploymentName: string,
  serviceName: string,
  serviceCount: number,
): string {
  if (serviceCount <= 1) return deploymentName;
  return `${deploymentName}-${serviceName}`;
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
    // backup-coverage: captured-by:secrets
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
  serviceCount: number,
): Promise<void> {
  const name = serviceResourceName(input.deploymentName, serviceName, serviceCount);
  const labels = {
    app: name,
    // Required by container-console/service.ts:fetchPods label selector.
    'platform.io/managed': 'true',
    // Required by listDeploymentComponents to identify the component name.
    component: serviceName,
    // Stack-level label so all Pods of all services in this
    // deployment share a discriminator — used by image-audit's
    // pod-listing label selector and by the delete-by-label sweep.
    'platform.phoenix-host.net/deployment-id': input.deploymentId,
    'platform.phoenix-host.net/owner': 'custom-deployments',
    'platform.phoenix-host.net/stack-service': serviceName,
  };
  const selectorLabels = { app: name };

  const container = buildContainer(serviceName, service, input);
  const podVolumes = buildPodVolumes(input.spec, input, service);
  const initDirs = buildInitDirsContainer(input, service);
  const dependsOnInits = buildDependsOnInitContainers(input, service, serviceCount);

  // Init containers run in declared order. depends_on waiters MUST
  // complete before init-dirs (cheap, network-bound) — the order
  // doesn't actually matter for correctness, but waiters first
  // means a deploy that's blocked on a missing dep surfaces the
  // wait quickly in `kubectl describe pod` rather than after the
  // mkdir step.
  const initContainers: Record<string, unknown>[] = [];
  initContainers.push(...dependsOnInits);
  if (initDirs) initContainers.push(initDirs);

  const podSpec: Record<string, unknown> = {
    containers: [container],
    priorityClassName: TENANT_DEFAULT_PRIORITY_CLASS,
    securityContext: buildPodSecurityContext(service, input.spec),
    restartPolicy: service.restartPolicy === 'Never' ? 'Never' : 'Always',
    ...(initContainers.length > 0 ? { initContainers } : {}),
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
    // k8s SDK error messages have been observed to echo the request
    // payload (e.g. the tenant's `env:` block, which can carry inline
    // credentials). Scrub via wrapK8sDeployerError before the error
    // can land in `deployments.last_error` and become visible to
    // admins via the admin panel.
    if (!isK8s409(err)) throw wrapK8sDeployerError(err, 'Deployment', name, 'create');
    // Patch the existing Deployment in place. Strategic-merge replaces
    // the `template` block as a unit so changes to image / env / etc.
    // propagate cleanly.
    try {
      await k8s.apps.patchNamespacedDeployment(
        { name, namespace: input.namespace, body } as unknown as Parameters<typeof k8s.apps.patchNamespacedDeployment>[0],
        STRATEGIC_MERGE_PATCH,
      );
    } catch (patchErr) {
      throw wrapK8sDeployerError(patchErr, 'Deployment', name, 'patch');
    }
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
  // Asymmetric QoS (ADR-037):
  //   CPU:    request only, NO limit — fair-throttled by cgroup shares
  //           under contention, free burst within the customer's
  //           ResourceQuota on `requests.cpu`. A custom deployment with
  //           an explicit `cpuLimit` in the spec is honoured (legacy
  //           tenants who set one explicitly opt out of bursting).
  //   Memory: request == limit (Guaranteed) — protects against OOM and
  //           cross-tenant kubelet eviction. `memoryLimit` from the spec
  //           is honoured only when ≥ memoryRequest; otherwise we clamp
  //           to memoryRequest to keep the Guaranteed shape.
  const cpuLimit = service.resources.cpuLimit; // undefined ⇒ no limit
  const memLimit = service.resources.memoryLimit ?? service.resources.memoryRequest;

  // Compose's `entrypoint:` → k8s `command` (k8s docs call it "Entrypoint Array").
  // Compose's `command:`    → k8s `args`    (k8s docs call it "Cmd Array").
  // The custom-deployments schema uses the docker terms; map them to
  // k8s names here.
  const k8sCommand = service.entrypoint && service.entrypoint.length > 0 ? service.entrypoint : undefined;
  const k8sArgs = service.command && service.command.length > 0 ? service.command : undefined;

  // Liveness + readiness probes derived from the same healthcheck —
  // compose only models one. Using the same shape for both is the
  // standard k8s pattern when the user didn't differentiate.
  const probe = service.healthCheck ? renderProbe(service.healthCheck) : undefined;

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
      limits: cpuLimit !== undefined
        ? { cpu: cpuLimit, memory: memLimit }
        : { memory: memLimit },
    },
    securityContext: buildContainerSecurityContext(service, input.spec),
    ...(service.workingDir ? { workingDir: service.workingDir } : {}),
    ...(probe ? { livenessProbe: probe, readinessProbe: probe } : {}),
  };
}

/**
 * Convert a CustomDeploymentHealthCheck to a k8s Probe spec.
 *
 * The three healthCheck variants map directly:
 *   - httpGet  → probe.httpGet { path, port, scheme, httpHeaders }
 *   - tcpSocket → probe.tcpSocket { port }
 *   - exec     → probe.exec { command }
 *
 * Timing fields use the same names + units as k8s. successThreshold
 * is forced to 1 for liveness probes (k8s requires it) but the
 * schema already defaults to 1.
 */
function renderProbe(hc: CustomDeploymentService['healthCheck']): Record<string, unknown> | undefined {
  if (!hc) return undefined;
  const timing = {
    initialDelaySeconds: hc.initialDelaySeconds,
    periodSeconds: hc.periodSeconds,
    timeoutSeconds: hc.timeoutSeconds,
    failureThreshold: hc.failureThreshold,
    successThreshold: hc.successThreshold,
  };
  if (hc.type === 'httpGet') {
    return {
      httpGet: {
        path: hc.path,
        port: hc.port,
        scheme: hc.scheme ?? 'HTTP',
        ...(hc.httpHeaders ? { httpHeaders: hc.httpHeaders } : {}),
      },
      ...timing,
    };
  }
  if (hc.type === 'tcpSocket') {
    return { tcpSocket: { port: hc.port }, ...timing };
  }
  return { exec: { command: hc.command }, ...timing };
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
    const mountKind = vm.kind ?? 'volume';
    if (mountKind === 'configMap') {
      mounts.push({
        name: configMapVolumeName(input.deploymentId, vm.name),
        mountPath: vm.containerPath,
        subPath: 'content',
        ...(vm.readOnly ? { readOnly: true } : {}),
      });
    } else if (mountKind === 'secret') {
      mounts.push({
        name: secretVolumeName(input.deploymentId, vm.name),
        mountPath: vm.containerPath,
        subPath: 'content',
        readOnly: true,
      });
    } else {
      mounts.push({
        name: CLIENT_PVC_VOLUME_NAME,
        mountPath: vm.containerPath,
        subPath: `${input.storageSubPath}/${vm.name}`,
        ...(vm.readOnly ? { readOnly: true } : {}),
      });
    }
  }

  for (const t of service.tmpfs) {
    mounts.push({
      name: tmpfsVolumeName(t.path),
      mountPath: t.path,
    });
  }

  return mounts;
}

/**
 * Pod-level volumes for ONE service. Multi-service stacks share the
 * top-level `spec.volumes` declarations but each service may only
 * use a subset; we add only what THIS service references so unused
 * volumes don't get dragged into every Pod.
 */
function buildPodVolumes(
  _spec: CustomDeploymentSpec,
  input: DeployCustomInput,
  service: CustomDeploymentService,
): Array<Record<string, unknown>> {
  const volumes: Array<Record<string, unknown>> = [];

  // 1. Tenant PVC — included if THIS service has at least one named volume mount.
  const hasNamedVolumes = service.volumeMounts.some((vm) => (vm.kind ?? 'volume') === 'volume');
  if (hasNamedVolumes) {
    volumes.push({
      name: CLIENT_PVC_VOLUME_NAME,
      persistentVolumeClaim: { claimName: `${input.namespace}-storage` },
    });
  }

  // 2. ConfigMap volumes — one per unique configMap mount.
  const configMapsSeen = new Set<string>();
  for (const vm of service.volumeMounts) {
    if ((vm.kind ?? 'volume') !== 'configMap') continue;
    const volName = configMapVolumeName(input.deploymentId, vm.name);
    if (configMapsSeen.has(volName)) continue;
    configMapsSeen.add(volName);
    volumes.push({
      name: volName,
      configMap: {
        name: renderConfigMapName(input.deploymentId, vm.name),
        defaultMode: 0o644,
      },
    });
  }

  // 3. Secret volumes — one per unique secret mount.
  const secretsSeen = new Set<string>();
  for (const vm of service.volumeMounts) {
    if ((vm.kind ?? 'volume') !== 'secret') continue;
    const volName = secretVolumeName(input.deploymentId, vm.name);
    if (secretsSeen.has(volName)) continue;
    secretsSeen.add(volName);
    volumes.push({
      name: volName,
      secret: {
        secretName: renderSecretName(input.deploymentId, vm.name),
        defaultMode: 0o400,
      },
    });
  }

  // 4. Tmpfs emptyDirs — per-service (not pod-wide).
  const tmpfsSeen = new Set<string>();
  for (const t of service.tmpfs) {
    const name = tmpfsVolumeName(t.path);
    if (tmpfsSeen.has(name)) continue;
    tmpfsSeen.add(name);
    volumes.push({
      name,
      emptyDir: { medium: 'Memory', sizeLimit: `${t.sizeMi}Mi` },
    });
  }

  return volumes;
}

/**
 * init-dirs initContainer for ONE service. Only pre-creates the
 * subPath directories THIS service mounts — a stack with two
 * services sharing a `data` volume gets the directory created twice
 * (idempotent: `mkdir -p` followed by `chmod 777`), which is cheap.
 */
function buildInitDirsContainer(
  input: DeployCustomInput,
  service: CustomDeploymentService,
): Record<string, unknown> | null {
  // Only pre-create directories for named volume mounts (PVC subPaths).
  // ConfigMap/Secret mounts are k8s-managed and don't need dir pre-creation.
  const namedVolumes = [...new Set(
    service.volumeMounts
      .filter((vm) => (vm.kind ?? 'volume') === 'volume')
      .map((vm) => vm.name),
  )];
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

/**
 * Render one initContainer per `service.dependsOn` entry. Each
 * waits for the dependency's first `exposeAsService` port to accept
 * a TCP connection (poll loop with 1s sleep, wrapped in a 60s
 * timeout — failing fast catches a stuck dependency rather than
 * pinning the Pod in Init forever).
 *
 * Dependencies that declare no exposed Service ports are skipped
 * with a log line (the busybox `echo` is the operator-visible
 * signal that the wait was no-op).
 */
function buildDependsOnInitContainers(
  input: DeployCustomInput,
  service: CustomDeploymentService,
  serviceCount: number,
): Array<Record<string, unknown>> {
  if (service.dependsOn.length === 0) return [];

  const out: Array<Record<string, unknown>> = [];
  // Collision-safe init-container names. The slug() function
  // truncates at 47 chars to leave room for the `wait-` prefix
  // (5 chars) + a numeric suffix (-NN, up to 3 chars) inside the
  // 63-char DNS-label limit. If two dependency names truncate to
  // the same slug we append `-2`, `-3`, … to dedupe.
  const usedNames = new Set<string>();
  for (const depName of service.dependsOn) {
    const dep = input.spec.services[depName];
    if (!dep) {
      // Validator already rejects this; defensive skip in the deployer.
      continue;
    }
    const firstPort = dep.ports.find((p) => p.exposeAsService);
    if (!firstPort) {
      // No Service exposed → no wait target. Emit a no-op init that
      // logs an explanation, so the operator can see in `kubectl
      // describe pod` that depends_on=<dep> was acknowledged but
      // couldn't be waited on.
      out.push({
        name: uniqueInitName(usedNames, depName),
        image: INIT_DIRS_IMAGE,
        command: ['sh', '-c', `echo "depends_on '${depName}' has no exposed service port; skipping wait"`],
        resources: {
          requests: { cpu: '5m', memory: '8Mi' },
          limits: { cpu: '20m', memory: '16Mi' },
        },
      });
      continue;
    }
    // Resolve the dependency's k8s Service DNS name.
    const depDeploymentName = serviceResourceName(input.deploymentName, depName, serviceCount);
    const depServiceName = `${depDeploymentName}-${firstPort.name}`;
    // 60s outer timeout. nc -z polls the port; sleep 1 between
    // attempts so we don't pin a CPU. -w 2 on nc caps each probe
    // at 2s in case the dependency's Pod is mid-startup and the
    // DNS resolves but the connection hangs.
    const waitCmd = `timeout 60 sh -c 'until nc -z -w 2 ${depServiceName} ${firstPort.containerPort}; do sleep 1; done'`;
    out.push({
      name: uniqueInitName(usedNames, depName),
      image: INIT_DIRS_IMAGE,
      command: ['sh', '-c', waitCmd],
      resources: {
        requests: { cpu: '5m', memory: '8Mi' },
        limits: { cpu: '20m', memory: '16Mi' },
      },
    });
  }
  return out;
}

/**
 * Generate a unique init-container name from a dependency name.
 * Strategy: `wait-{slug}`; if that slug is already taken (two deps
 * truncate to the same string), append `-2`, `-3`, … until free.
 * Records the chosen name in `usedNames` so future calls see it.
 */
function uniqueInitName(usedNames: Set<string>, depName: string): string {
  const base = `wait-${slug(depName)}`;
  if (!usedNames.has(base)) {
    usedNames.add(base);
    return base;
  }
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
  }
  // Extreme edge case (validator caps depends_on at ~10 entries):
  // fall through to a uuid suffix.
  const fallback = `${base}-${Math.random().toString(36).slice(2, 6)}`;
  usedNames.add(fallback);
  return fallback;
}

/** Shorten + sanitise a service name for use in initContainer names
 *  (which must obey RFC 1123 label rules and stay ≤ 63 chars total).
 *  Cap at 47 chars: 5 (`wait-`) + 47 (slug) + 4 (-NN dedupe suffix)
 *  = 56 < 63. Keeps headroom for the dedupe counter. */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 47);
}

// ─── Service renderer ───────────────────────────────────────────────────────

async function applyService(
  k8s: K8sClients,
  input: DeployCustomInput,
  serviceName: string,
  port: CustomDeploymentService['ports'][number],
  serviceCount: number,
): Promise<void> {
  const owningDeploymentName = serviceResourceName(input.deploymentName, serviceName, serviceCount);
  const name = `${owningDeploymentName}-${port.name}`;
  const labels = {
    app: owningDeploymentName,
    'platform.phoenix-host.net/deployment-id': input.deploymentId,
    'platform.phoenix-host.net/owner': 'custom-deployments',
    'platform.phoenix-host.net/stack-service': serviceName,
    ...(port.ingressEligible ? { 'platform.phoenix-host.net/ingress-eligible': 'true' } : {}),
  };
  const body = {
    metadata: { name, namespace: input.namespace, labels },
    spec: {
      type: 'ClusterIP',
      // Selector targets ONLY this service's Pods (multi-service
      // stacks have one Deployment per service, each with a unique
      // `app=` label).
      selector: { app: owningDeploymentName },
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
    if (!isK8s409(err)) throw wrapK8sDeployerError(err, 'Service', name, 'create');
    // For Services, immutable fields (clusterIP, selector under some
    // conditions) make strategic-merge brittle. We do a narrow patch
    // of `spec.ports` only — that's the field tenants change most
    // when iterating. Selector + clusterIP stay stable.
    try {
      await k8s.core.patchNamespacedService(
        { name, namespace: input.namespace, body: { spec: { ports: body.spec.ports } } } as unknown as Parameters<typeof k8s.core.patchNamespacedService>[0],
        STRATEGIC_MERGE_PATCH,
      );
    } catch (patchErr) {
      throw wrapK8sDeployerError(patchErr, 'Service', name, 'patch');
    }
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
  // Only set runAsNonRoot:true when the spec explicitly declares a non-zero
  // UID.  If no runAsUser is declared we cannot know the image's default USER
  // — many stock images (nginx, redis, …) run as root without declaring it.
  // PSS baseline on the namespace is the real enforcement layer; we should
  // not over-restrict at the pod-spec level.
  const hasExplicitNonRootUid =
    service.runAsUser !== undefined && service.runAsUser > 0;
  if (hasExplicitNonRootUid) {
    ctx.runAsNonRoot = true;
  }
  if (service.runAsUser !== undefined) ctx.runAsUser = service.runAsUser;
  if (service.runAsGroup !== undefined) ctx.runAsGroup = service.runAsGroup;
  if (service.sysctls && Object.keys(service.sysctls).length > 0) {
    ctx.sysctls = Object.entries(service.sysctls).map(([name, value]) => ({ name, value }));
  }
  return ctx;
}

function buildContainerSecurityContext(
  service: CustomDeploymentService,
  _spec: CustomDeploymentSpec,
): Record<string, unknown> {
  // PSS baseline does NOT require `capabilities.drop:[ALL]` — that is a
  // PSS *restricted* requirement. Dropping ALL breaks many stock images
  // (nginx needs CHOWN during startup, etc.). We keep
  // `allowPrivilegeEscalation:false` (safe for nearly all images) but
  // leave capability management to the image's own USER/capabilities
  // declarations. The namespace PSS-baseline admission controller handles
  // actually dangerous capabilities (NET_RAW, SYS_ADMIN, …).
  const ctx: Record<string, unknown> = {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: service.readOnlyRootFilesystem,
  };
  // PSS baseline does NOT forbid root by itself; PSS restricted does.
  // The validator gates `runAsUser:0` on the admin-only `allowRoot`
  // flag, so here we just propagate what the spec asked for.
  if (service.runAsUser !== undefined) ctx.runAsUser = service.runAsUser;
  if (service.runAsGroup !== undefined) ctx.runAsGroup = service.runAsGroup;
  if (service.capAdd && service.capAdd.length > 0) {
    ctx.capabilities = { add: service.capAdd };
  }
  return ctx;
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

function configMapVolumeName(deploymentId: string, key: string): string {
  // Pod volume name for a projected ConfigMap. Short prefix to stay
  // under the 63-char DNS-label limit for volume names.
  return `cdcm-${deploymentId.slice(0, 8)}-${key}`.slice(0, 63);
}

function secretVolumeName(deploymentId: string, key: string): string {
  return `cdsec-${deploymentId.slice(0, 8)}-${key}`.slice(0, 63);
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
  _deploymentName: string,
): Promise<void> {
  const selector = `platform.phoenix-host.net/deployment-id=${deploymentId}`;

  // Multi-service stacks (PR-3) have one Deployment per service —
  // listing by the deployment-id label covers them all in a single
  // pass. The legacy by-name shortcut from PR-2 has been removed
  // because it only matched the single-service case.
  await deleteByLabel(k8s, namespace, selector, 'deployment');
  await deleteByLabel(k8s, namespace, selector, 'service');
  await deleteByLabel(k8s, namespace, selector, 'configmap');
  await deleteByLabel(k8s, namespace, selector, 'secret');
}

async function deleteByLabel(
  k8s: K8sClients,
  namespace: string,
  labelSelector: string,
  kind: 'deployment' | 'service' | 'configmap' | 'secret',
): Promise<void> {
  switch (kind) {
    case 'deployment': {
      const list = await k8s.apps.listNamespacedDeployment({ namespace, labelSelector } as Parameters<typeof k8s.apps.listNamespacedDeployment>[0]) as unknown as { items: Array<{ metadata?: { name?: string } }> };
      for (const item of list.items ?? []) {
        const n = item.metadata?.name;
        if (n) await k8s.apps.deleteNamespacedDeployment({ name: n, namespace }).catch(swallow404);
      }
      return;
    }
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
  return isNotFound(err);
}
