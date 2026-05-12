/**
 * Multi-component K8s deployer.
 *
 * Creates/manages Deployments, CronJobs, and Services for catalog entries
 * in client namespaces. For single-writer-per-tenant workloads (one
 * WordPress + one MariaDB per blog, etc.), a Deployment with strategy:
 * Recreate and the client's shared PVC mounted via subPath delivers
 * everything a StatefulSet would, with less complexity:
 *   - single replica → no ordered rollout / stable-pod-name need
 *   - shared PVC → one PVC per client, not N per app
 *   - Recreate → stop old pod before new, safe for databases
 *
 * `type: statefulset` in legacy catalog manifests is accepted for
 * backward compat and emits a Deployment with a deprecation warning.
 * Normalized catalog (k8s-application-catalog @ f20965f) uses only
 * `type: deployment | cronjob | job`.
 */

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { buildPasswordResetInitContainer } from './password-reset.js';
import { STRATEGIC_MERGE_PATCH } from '../../shared/k8s-patch.js';
import { allocateResources, InsufficientResourceBudgetError } from './resource-allocator.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DeployComponentInput {
  readonly name: string;
  readonly type: 'deployment' | 'statefulset' | 'cronjob' | 'job';
  readonly image: string;
  readonly ports: Array<{ port: number; protocol: string; ingress?: boolean }>;
  readonly optional?: boolean;
  readonly schedule?: string;
  /**
   * Per-component volume scoping. Each entry must match a top-level volume's
   * `local_path` basename (e.g. `content`, `database`). Unset = legacy behavior
   * (component mounts every app-level volume). Empty array = component mounts
   * nothing (useful for stateless caches like redis/collabora).
   */
  readonly volumes?: readonly string[];
  /**
   * Container entrypoint override. Needed for one-shot install jobs that run
   * a bootstrap script (e.g. WordPress's wp-install job executes `wp core
   * install`). When unset, the image's default ENTRYPOINT + CMD are used.
   */
  readonly command?: readonly string[];
  readonly args?: readonly string[];
  /**
   * Per-component resource override. One-shot jobs (wp-install, migrate
   * jobs) should declare small footprints — sharing the app-level
   * `cpuRequest`/`memoryRequest` of a WordPress deploy (250m/512Mi) wastes
   * client ResourceQuota on a container that runs for 15 seconds. When
   * unset, falls back to the top-level `cpuRequest`/`memoryRequest`.
   *
   * Components that declare `resources` are excluded from the weighted
   * budget split — their declared values are used verbatim, and the
   * allocator distributes the deployment-level `cpuRequest`/`memoryRequest`
   * across the remaining components.
   */
  readonly resources?: { readonly cpu?: string; readonly memory?: string };
  /**
   * Weighted share for multi-component budget allocation. When every
   * budget-bearing component in a deployment declares one, the
   * deployment-level `cpuRequest`/`memoryRequest` is split by these
   * weights (after each component's minCpu/minMemory is honoured).
   * Sync-time validation enforces all-or-nothing.
   */
  readonly resourceShare?: {
    readonly weight: number;
    readonly minCpu?: string;
    readonly minMemory?: string;
  };
}

export interface DeployCatalogEntryInput {
  readonly deploymentName: string;
  readonly storagePath: string;
  readonly namespace: string;
  readonly components: readonly DeployComponentInput[];
  readonly volumes: Array<{ container_path: string; local_path?: string | null }>;
  readonly replicaCount: number;
  readonly cpuRequest: string;
  readonly memoryRequest: string;
  readonly storageRequest?: string;
  readonly configuration?: Record<string, unknown>;
  readonly envVars?: { fixed?: Record<string, string> };
  /**
   * Whitelist of env-var names the user may override via `configuration`.
   * When set, arbitrary `configuration` keys no longer leak into the pod env —
   * only keys in this list (plus env_vars.fixed / generated) are injected.
   * Leaving undefined preserves pre-filter (legacy) behavior so older call
   * sites keep working unchanged.
   */
  readonly configurableEnvKeys?: readonly string[];
  /** When true, adds a password-reset init container for reused data */
  readonly reuseExistingData?: boolean;
  /** Catalog entry code (e.g. 'mariadb', 'mysql', 'postgresql') — needed for password reset */
  readonly catalogCode?: string;
  /** Password env var name (e.g. 'MARIADB_ROOT_PASSWORD') */
  readonly passwordEnvVar?: string;
  /** Client timezone — injected as TZ env var */
  readonly timezone?: string;
  /**
   * M5: worker pin from clients.worker_node_name. Null/undefined lets
   * the default scheduler pick any node matching the implicit
   * constraints (server-only taints prevent tenant pods from landing
   * on tainted control-plane nodes). When set:
   *   - Local tier: hard nodeSelector (pod must run on that node).
   *   - HA tier: soft preferred affinity (pod can fail over).
   */
  readonly workerNodeName?: string | null;
  /**
   * Storage tier from clients.storage_tier. Drives whether the worker
   * pin is hard (nodeSelector) or soft (preferred affinity). HA tier
   * MUST use soft so the pod can reschedule when the pin node fails.
   */
  readonly storageTier?: 'local' | 'ha' | null;
  /**
   * Runtime-firewall declaration propagated from the catalog manifest.
   * When present, the deployer stamps two annotations onto the Pod
   * template (`platform.io/firewall-tcp-ports`, `platform.io/firewall-udp-ports`)
   * which the firewall-reconciler DaemonSet picks up to populate
   * the host nft sets `tenant_ports_{tcp,udp}`. The catalog deploy gate
   * in service.ts is responsible for refusing to deploy when the
   * corresponding system_settings.allow_host_ports_{server,worker}
   * toggle is OFF — by the time we reach this layer the gate has
   * already approved the exposure.
   *
   * UDP ports support nft-style range strings (e.g. `"16384-32768"`)
   * because TURN/RTP relays need port pools. TCP ports are typed as
   * numbers in the manifest but stringified here so both sets share the
   * same annotation format.
   */
  readonly firewall?: { tcp?: readonly number[]; udp?: readonly (number | string)[] };
  /**
   * Manifest's `networking.host_ports[]`: each entry binds the named
   * component's container port to the host's network namespace
   * (`hostPort` in k8s spec). Without this, the firewall reconciler
   * opens the kernel rule for the port, but no process listens on the
   * host — STUN/TURN traffic times out at the wire.
   *
   * The catalog deploy gate (service.ts) has already approved the
   * exposure by the time we land here; it's safe to stamp `hostPort` on
   * the matching container port unconditionally.
   */
  readonly hostPorts?: readonly { component: string; port: number; protocol: 'TCP' | 'UDP' }[];
}

export interface ComponentPodStatus {
  readonly name: string;
  readonly type: string;
  readonly phase: 'not_deployed' | 'starting' | 'running' | 'failed' | 'stopped';
  readonly ready: boolean;
  readonly message?: string;
  /** Node hosting the pod, when scheduled (used by status-reconciler to populate deployments.current_node_name). */
  readonly nodeName?: string | null;
}

export interface AggregateDeploymentStatus {
  readonly phase: 'not_deployed' | 'starting' | 'running' | 'failed' | 'stopped';
  readonly ready: boolean;
  readonly components: readonly ComponentPodStatus[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isK8s404(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('HTTP-Code: 404')) return true;
  if ((err as { statusCode?: number }).statusCode === 404) return true;
  return false;
}

function isK8s409(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('HTTP-Code: 409')) return true;
  if ((err as { statusCode?: number }).statusCode === 409) return true;
  return false;
}

function deploymentLabels(deploymentName: string, componentName: string): Record<string, string> {
  return {
    app: deploymentName,
    component: componentName,
    'platform.io/managed': 'true',
  };
}

/**
 * Render the catalog manifest's `firewall` block into the two pod
 * annotations the firewall-reconciler watches for. Returns
 * `undefined` when no host ports are requested so the rendered Pod
 * carries no annotations at all (clean diff for non-firewall apps).
 *
 * Both keys use comma-separated values; UDP supports nft-style ranges
 * (e.g. `"16384-32768"`). Numbers are stringified to keep the
 * annotation map a homogenous Record<string,string>.
 */
export function buildFirewallAnnotations(
  firewall?: { tcp?: readonly number[]; udp?: readonly (number | string)[] },
): Record<string, string> | undefined {
  if (!firewall) return undefined;
  const tcp = (firewall.tcp ?? []).map(String).filter(s => s.length > 0);
  const udp = (firewall.udp ?? []).map(String).filter(s => s.length > 0);
  if (tcp.length === 0 && udp.length === 0) return undefined;
  const out: Record<string, string> = {};
  if (tcp.length > 0) out['platform.io/firewall-tcp-ports'] = tcp.join(',');
  if (udp.length > 0) out['platform.io/firewall-udp-ports'] = udp.join(',');
  return out;
}

function k8sResourceName(deploymentName: string, componentName: string, componentCount: number): string {
  if (componentCount <= 1) return deploymentName;
  return `${deploymentName}-${componentName}`;
}

/** Regex for a valid single-segment local_path (shared with catalog sync validator). */
export const LOCAL_PATH_SEGMENT_RE = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * Derive a stable per-volume subdirectory key from the manifest's `local_path`.
 *
 * Returns:
 *   - `null`  when `local_path` is `"."` or missing/null → mount the PVC root
 *             with no subPath (entire PVC at `container_path`).
 *   - `string` when `local_path` matches `/^[a-z][a-z0-9_-]{0,63}$/` → use
 *              that exact name as the subPath suffix.
 *
 * Any other value (multi-segment path, absolute path, etc.) throws — these
 * should already be caught at catalog-sync time, but this is a defence-in-depth
 * guard so a malformed entry can't silently mount the wrong directory.
 */
export function volumeKey(v: { container_path: string; local_path?: string | null }): string | null {
  const lp = v.local_path;
  if (!lp || lp === '.') return null;
  if (LOCAL_PATH_SEGMENT_RE.test(lp)) return lp;
  throw new Error(`volumeKey: invalid local_path "${lp}" — expected "." or a single lowercase segment`);
}

/**
 * Filter the app-level volumes array down to the set this component actually
 * needs. When `componentVolumes` is undefined (legacy manifests without per-
 * component bindings) the full array is returned — preserves pre-scoping
 * behavior. An explicit empty array returns nothing (stateless component).
 *
 * With the new flat `local_path` contract, component volume references are
 * exact-match against `local_path` (e.g. `"content"`, `"database"`).
 * The `"."` (PVC-root) volume matches the sentinel string `"."` — but in
 * practice single-volume manifests leave `componentVolumes` unset, so this
 * branch is mainly for correctness.
 */
function filterVolumesForComponent(
  appVolumes: Array<{ container_path: string; local_path?: string | null }>,
  componentVolumes: readonly string[] | undefined,
): Array<{ container_path: string; local_path?: string | null }> {
  if (componentVolumes === undefined) return appVolumes;
  if (componentVolumes.length === 0) return [];
  const want = new Set(componentVolumes);
  return appVolumes.filter(v => {
    const lp = v.local_path;
    // "." volumes match if the component explicitly asked for "."
    if (!lp || lp === '.') return want.has('.');
    return want.has(lp);
  });
}

/**
 * Produce volumeMounts + the init-dirs init container + the pod-level volumes
 * entry for a given set of volumes, all referencing the shared client PVC.
 * Returns `null` when the component mounts nothing (caller skips PVC entirely).
 *
 * When `local_path === "."` (or missing), the mount has no `subPath` — the
 * entire PVC root is mounted at `container_path`. When `local_path` is a
 * single segment (e.g. `"content"`), `subPath` is `<storagePath>/<segment>`.
 */
function buildVolumeMountSpec(
  volumes: Array<{ container_path: string; local_path?: string | null }>,
  storagePath: string,
  namespace: string,
): {
  mounts: Array<{ name: string; mountPath: string; subPath?: string }>;
  podVolumes: Array<Record<string, unknown>>;
  initDirsContainer: Record<string, unknown>;
} | null {
  if (volumes.length === 0) return null;

  // Mount semantics — `local_path` controls the layout under the shared PVC:
  //   - `"."` (or null): the deployment's data dir is the storagePath itself.
  //     subPath = storagePath (e.g. `runtime/nginx-php/my-site`).
  //   - `"<segment>"`: sub-directory under storagePath.
  //     subPath = `${storagePath}/${segment}` (e.g.
  //     `application/wordpress/my-site/content`).
  //
  // Both cases land under storagePath. This keeps every deployment's data
  // discoverable at a predictable path for backup/restore tools, and lets
  // the per-deployment cleanup safely `rm -rf` just its subtree.
  //
  // (Older builds left `local_path: "."` mounts at the PVC root with no
  // subPath. Deployments created before this fix have their data at the
  // PVC root; they keep working but the new layout only applies to fresh
  // deploys. A redeploy would not migrate data — operators wanting the
  // new layout must export → recreate.)
  const mounts = volumes.map(v => {
    const key = volumeKey(v);
    if (key === null) {
      // PVC-root sentinel ('.' or null) → mount storagePath, no extra key.
      // storagePath is guaranteed non-empty in normal deploys (service.ts
      // sets it to `${type}/${code}/${name}` at create time); the empty
      // string fallback exists only for the legacy test path that didn't
      // pass storagePath.
      if (!storagePath) {
        return { name: 'client-storage', mountPath: v.container_path };
      }
      return { name: 'client-storage', mountPath: v.container_path, subPath: storagePath };
    }
    const subPath = storagePath ? `${storagePath}/${key}` : key;
    return { name: 'client-storage', mountPath: v.container_path, subPath };
  });

  // Every mount needs its target directory to exist + be writable by the
  // application's runtime user. The PVC is provisioned root:root 0755 by
  // local-path/Longhorn, and most images run as non-root (postgres=999,
  // bitnami=1001, serversideup/php=33, etc.). The init-dirs container
  // pre-creates each subPath with chmod 777 so any image's runtime user
  // can write on first boot.
  //
  // 0777 is acceptable because each tenant gets its own PVC — there's
  // nothing across-tenant to leak. fsGroup at pod level was considered
  // but rejected: no single GID fits all images, and fsGroup recursively
  // chmods on every pod start which is slow on large PVCs.
  const mkdirParts: string[] = [];
  for (const m of mounts) {
    if (m.subPath !== undefined) {
      mkdirParts.push(`mkdir -p /data/${m.subPath} && chmod 777 /data/${m.subPath}`);
    } else {
      // Legacy / test path: no storagePath set, mount is the whole PVC.
      mkdirParts.push('chmod 777 /data');
    }
  }
  const mkdirCmd = mkdirParts.length > 0 ? mkdirParts.join(' && ') : 'true';

  const initDirsContainer = {
    name: 'init-dirs',
    image: 'busybox:1.36',
    command: ['sh', '-c', mkdirCmd],
    volumeMounts: [{ name: 'client-storage', mountPath: '/data' }],
    // Asymmetric QoS (ADR-037): CPU request only, memory request==limit.
    resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { memory: '32Mi' } },
  };

  const podVolumes = [{ name: 'client-storage', persistentVolumeClaim: { claimName: `${namespace}-storage` } }];

  return { mounts, podVolumes, initDirsContainer };
}

/**
 * Expand template tokens in a single env-var value:
 *   {{SERVICE:<component-name>}} → `${deploymentName}-${component}` (or just
 *       `${deploymentName}` when the app has one component).
 *   {{ENV:<env-var-name>}} → value of that env var if already declared in
 *       this deployment's env map, else throws.
 *   {{ENV_URLSAFE:<env-var-name>}} → same as {{ENV:*}} but the value is
 *       percent-encoded for use inside URLs. Necessary when a generated
 *       password contains reserved chars (`@:/?&=#`) that would corrupt
 *       a connection string like `mongodb://user:pass@host/db`.
 *
 * Unknown component refs throw loudly — a typo would otherwise produce a
 * silent empty string and confuse debugging later.
 */
function expandTokens(
  raw: string,
  ctx: { deploymentName: string; componentNames: readonly string[]; componentCount: number; envMap: Map<string, string> },
): string {
  let out = raw;
  out = out.replace(/\{\{SERVICE:([^}]+)\}\}/g, (_m, comp: string) => {
    const name = comp.trim();
    if (!ctx.componentNames.includes(name)) {
      throw new Error(`env template: unknown component "${name}" referenced via {{SERVICE:${name}}}`);
    }
    return ctx.componentCount <= 1 ? ctx.deploymentName : `${ctx.deploymentName}-${name}`;
  });
  out = out.replace(/\{\{ENV_URLSAFE:([^}]+)\}\}/g, (_m, envName: string) => {
    const name = envName.trim();
    const v = ctx.envMap.get(name);
    if (v === undefined) {
      throw new Error(`env template: unknown env var "${name}" referenced via {{ENV_URLSAFE:${name}}}`);
    }
    return encodeURIComponent(v);
  });
  out = out.replace(/\{\{ENV:([^}]+)\}\}/g, (_m, envName: string) => {
    const name = envName.trim();
    const v = ctx.envMap.get(name);
    if (v === undefined) {
      throw new Error(`env template: unknown env var "${name}" referenced via {{ENV:${name}}}`);
    }
    return v;
  });
  return out;
}

function buildEnvVars(
  fixed: Record<string, string> | undefined,
  configuration: Record<string, unknown> | undefined,
  opts: {
    deploymentName: string;
    componentNames: readonly string[];
    componentCount: number;
    configurableEnvKeys?: readonly string[];
  },
): Array<{ name: string; value: string }> {
  const envMap = new Map<string, string>();

  // Pass 1: fixed env vars — these may contain {{SERVICE:*}} / {{ENV:*}}.
  if (fixed) {
    for (const [key, value] of Object.entries(fixed)) {
      envMap.set(key, value); // raw; tokens expanded in pass 3
    }
  }

  // Pass 2: values from configuration.
  // - If configurableEnvKeys is set, only those keys + any already-fixed key
  //   flow through. Arbitrary meta params (e.g. `wordpress.siteTitle`) stay
  //   in `deployment.configuration` for platform use but aren't container env.
  // - If unset, pre-filter legacy behavior: every stringish key passes through.
  if (configuration) {
    const allowed = opts.configurableEnvKeys
      ? new Set(opts.configurableEnvKeys)
      : null;
    for (const [key, value] of Object.entries(configuration)) {
      if (envMap.has(key)) continue; // fixed wins
      if (allowed && !allowed.has(key)) continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        envMap.set(key, String(value));
      }
    }
  }

  // Pass 3: resolve tokens. Uses the map accumulated so far, so {{ENV:X}}
  // references can point at generated or configurable values.
  const ctx = {
    deploymentName: opts.deploymentName,
    componentNames: opts.componentNames,
    componentCount: opts.componentCount,
    envMap,
  };
  const expanded = new Map<string, string>();
  for (const [k, v] of envMap) {
    expanded.set(k, expandTokens(v, ctx));
  }

  return Array.from(expanded, ([name, value]) => ({ name, value }));
}

// ─── Deploy ─────────────────────────────────────────────────────────────────

export async function deployCatalogEntry(
  k8s: K8sClients,
  input: DeployCatalogEntryInput,
): Promise<void> {
  const { deploymentName, namespace, components, volumes, replicaCount, cpuRequest, memoryRequest, configuration, envVars, timezone, configurableEnvKeys } = input;
  const componentCount = components.length;
  const componentNames = components.map(c => c.name);
  const env = buildEnvVars(envVars?.fixed, configuration, {
    deploymentName,
    componentNames,
    componentCount,
    configurableEnvKeys,
  });

  // Inject client timezone as TZ env var (respected by most Linux base images)
  if (timezone && !env.some((e) => e.name === 'TZ')) {
    env.push({ name: 'TZ', value: timezone });
  }

  // Build password-reset init container for reused data directories
  const passwordResetContainer = input.reuseExistingData && input.catalogCode && input.passwordEnvVar
    ? buildPasswordResetInitContainer({
        catalogCode: input.catalogCode,
        image: components[0]?.image ?? '',
        storagePath: input.storagePath,
        volumeMountName: 'client-storage',
        passwordEnvVar: input.passwordEnvVar,
      })
    : null;

  // Weighted per-component allocation of the deployment-level CPU/memory
  // budget. Components with hard-pinned `resources` (one-shot Jobs, etc.)
  // are excluded from the budget; the remaining components share the
  // budget by their `resourceShare.weight`, with even-split fallback when
  // no shares are declared. Throws INSUFFICIENT_RESOURCE_BUDGET if the
  // sum of minimums exceeds the budget.
  const allocations = allocateResources(
    { cpu: cpuRequest, memory: memoryRequest },
    components.map((c) => ({
      name: c.name,
      type: c.type,
      resources: c.resources,
      resourceShare: c.resourceShare,
    })),
  );

  for (const component of components) {
    const name = k8sResourceName(deploymentName, component.name, componentCount);
    const labels = deploymentLabels(deploymentName, component.name);

    const allocation = allocations.get(component.name);
    const compCpu = component.resources?.cpu ?? allocation?.cpu ?? cpuRequest;
    const compMem = component.resources?.memory ?? allocation?.memory ?? memoryRequest;
    // Pull host-port bindings for this component out of the manifest's
    // top-level networking.host_ports[]. The shape is
    // `{ component, port, protocol }`; we match on component name and
    // (port, uppercase protocol) and stamp `hostPort` on the matching
    // containerPort. Missing match ⇒ container-only port (default).
    const hostPortFor = (port: number, proto: string): number | undefined => {
      const wanted = (proto || 'TCP').toUpperCase() === 'UDP' ? 'UDP' : 'TCP';
      const match = (input.hostPorts ?? []).find(hp =>
        hp.component === component.name && hp.port === port && hp.protocol === wanted,
      );
      return match ? port : undefined;
    };
    const container = {
      name: component.name,
      image: component.image,
      imagePullPolicy: 'Always' as const,
      ports: component.ports.map(p => {
        const hp = hostPortFor(p.port, (p as { protocol?: string }).protocol ?? 'TCP');
        return hp !== undefined
          ? { containerPort: p.port, hostPort: hp, ...(((p as { protocol?: string }).protocol === 'UDP' || (p as { protocol?: string }).protocol === 'udp') ? { protocol: 'UDP' } : {}) }
          : { containerPort: p.port, ...(((p as { protocol?: string }).protocol === 'UDP' || (p as { protocol?: string }).protocol === 'udp') ? { protocol: 'UDP' } : {}) };
      }),
      // Asymmetric QoS (ADR-037):
      //   CPU:    request only, no limit → bursts freely within node
      //           capacity, fair-throttled by cgroup shares under contention.
      //           Namespace-level ResourceQuota on `requests.cpu` is the
      //           customer-plan ceiling.
      //   Memory: request == limit → Guaranteed memory, no OOM risk from
      //           bursting. Memory is incompressible — kernel OOM-kill is
      //           non-graceful and kubelet eviction can cross namespaces.
      resources: {
        requests: { cpu: compCpu, memory: compMem },
        limits: { memory: compMem },
      },
      ...(component.command && component.command.length > 0 ? { command: [...component.command] } : {}),
      ...(component.args && component.args.length > 0 ? { args: [...component.args] } : {}),
      ...(env.length > 0 ? { env } : {}),
    };

    // Scope volumes to what this component actually needs. Undefined on the
    // component preserves legacy share-all; empty array means mounts nothing.
    const componentVolumes = filterVolumesForComponent(volumes, component.volumes);

    // Compute the firewall pod-template annotations once per call. They're
    // identical for every component because the firewall block lives at
    // the entry/manifest level — every pod the deploy emits should carry
    // the same set so the reconciler is consistent regardless of which
    // component the host-port lands in.
    const firewallAnnotations = buildFirewallAnnotations(input.firewall);

    switch (component.type) {
      case 'deployment':
        await deployK8sDeployment(k8s, namespace, name, labels, container, replicaCount, input.storagePath, componentVolumes, passwordResetContainer, env, input.workerNodeName, input.storageTier, firewallAnnotations);
        break;

      case 'statefulset':
        // Legacy manifest value — always emitted as a Deployment. Older
        // catalog_entries rows in the DB may still carry this type until
        // the next sync; warn and route through the Deployment path so the
        // install still succeeds.
        console.warn(
          `[deployer] component "${name}" in ${namespace} declares deprecated type 'statefulset'; emitting a Deployment. Update the catalog manifest to type: deployment.`,
        );
        await deployK8sDeployment(k8s, namespace, name, labels, container, replicaCount, input.storagePath, componentVolumes, passwordResetContainer, env, input.workerNodeName, input.storageTier, firewallAnnotations);
        break;

      case 'cronjob':
        await deployK8sCronJob(k8s, namespace, name, labels, container, component.schedule ?? '0 * * * *', input.storagePath, componentVolumes);
        break;

      case 'job':
        // Jobs are one-shot; create only
        await deployK8sJob(k8s, namespace, name, labels, container, input.storagePath, componentVolumes);
        break;
    }

    // Create Service for components that have ports
    if (component.ports.length > 0 && component.type !== 'cronjob' && component.type !== 'job') {
      await deployK8sService(k8s, namespace, name, labels, component.ports);
    }
  }

  // Tenant namespaces ship with a default-deny-ingress NetworkPolicy
  // (modules/k8s-provisioner/service.ts). For host-port apps the host's
  // nft set + CNI portmap let an external packet reach the pod's veth,
  // but the default-deny then drops it before it gets to the container.
  // Emit a per-deployment policy that allows ingress from anywhere on
  // exactly the firewall ports the operator opened — coupled with the
  // `firewall: { tcp, udp }` block, this is the third leg of the
  // runtime-firewall feature (host fw + hostPort + NetworkPolicy).
  if (input.firewall && (input.firewall.tcp?.length || input.firewall.udp?.length)) {
    await deployFirewallNetworkPolicy(k8s, namespace, input.deploymentName, input.firewall);
  }
}

async function deployFirewallNetworkPolicy(
  k8s: K8sClients,
  namespace: string,
  deploymentName: string,
  firewall: { tcp?: readonly number[]; udp?: readonly (number | string)[] },
): Promise<void> {
  // Build an `ingress` rule listing every numeric tcp/udp port. UDP
  // ranges (e.g. "16384-32768") aren't expressible in K8s
  // NetworkPolicy v1 — endPort is supported but only for a single
  // contiguous range per rule entry. For now, expand explicit numbers
  // and turn ranges into endPort tuples; if a manifest declares
  // multiple ranges or mixed ranges+singletons, each becomes its own
  // ingress rule entry.
  type PortEntry = { protocol: 'TCP' | 'UDP'; port: number; endPort?: number };
  const entries: PortEntry[] = [];
  for (const p of firewall.tcp ?? []) {
    if (typeof p === 'number') entries.push({ protocol: 'TCP', port: p });
  }
  for (const p of firewall.udp ?? []) {
    if (typeof p === 'number') {
      entries.push({ protocol: 'UDP', port: p });
    } else if (typeof p === 'string') {
      const m = p.match(/^(\d+)-(\d+)$/);
      if (m) entries.push({ protocol: 'UDP', port: Number(m[1]), endPort: Number(m[2]) });
      else if (/^\d+$/.test(p)) entries.push({ protocol: 'UDP', port: Number(p) });
    }
  }
  if (entries.length === 0) return;

  const npName = `firewall-allow-${deploymentName}`;
  const body = {
    metadata: {
      name: npName,
      namespace,
      labels: { 'app.kubernetes.io/managed-by': 'platform-api', 'platform.io/firewall-policy': deploymentName },
    },
    spec: {
      podSelector: { matchLabels: { app: deploymentName } },
      policyTypes: ['Ingress'],
      // from: [] (i.e. omitted) means "any source". This is by design —
      // STUN/TURN servers explicitly need internet ingress on these
      // ports, and the operator already opted in via the System
      // Settings host-port toggle + the catalog manifest.
      ingress: [{ ports: entries }],
    },
  };
  try {
    await (k8s as unknown as { networking: { createNamespacedNetworkPolicy: (args: { namespace: string; body: unknown }) => Promise<unknown> } })
      .networking.createNamespacedNetworkPolicy({ namespace, body });
  } catch (err) {
    if (isK8s409(err)) {
      await (k8s as unknown as { networking: { replaceNamespacedNetworkPolicy: (args: { name: string; namespace: string; body: unknown }) => Promise<unknown> } })
        .networking.replaceNamespacedNetworkPolicy({ name: npName, namespace, body });
    } else {
      throw err;
    }
  }
}

async function deployK8sDeployment(
  k8s: K8sClients,
  namespace: string,
  name: string,
  labels: Record<string, string>,
  container: Record<string, unknown>,
  replicaCount: number,
  storagePath: string,
  volumes: Array<{ container_path: string; local_path?: string | null }> = [],
  passwordResetContainer?: { name: string; image: string; command: readonly string[]; volumeMounts: readonly Record<string, unknown>[]; resources: Record<string, unknown>; securityContext?: Record<string, unknown> } | null,
  envVars?: Array<{ name: string; value: string }>,
  // M3/HA: optional worker pin + tier-aware affinity. Local tier =
  // hard nodeSelector (data is on that one node, pod can't run anywhere
  // else). HA tier = soft preference (Longhorn keeps a replica on the
  // pin node for locality, but if the node fails the scheduler is free
  // to move the pod to a node holding the surviving replica). Without
  // this distinction HA tier provides no actual failover — the pod
  // stays Pending forever waiting for the dead node to come back.
  workerNodeName?: string | null,
  storageTier?: 'local' | 'ha' | null,
  // Firewall annotations from the catalog manifest's `firewall` block.
  // Stamped onto the pod template's metadata (NOT the Deployment's
  // top-level metadata) so the firewall-reconciler can read them
  // off `kubectl get pods` output. The deploy gate in service.ts has
  // already enforced the per-role allow_host_ports toggle by the time
  // we land here.
  podAnnotations?: Record<string, string>,
): Promise<void> {
  const selectorLabels = { app: labels.app, component: labels.component };
  const spec = buildVolumeMountSpec(volumes, storagePath, namespace);

  const containerWithMounts = spec
    ? { ...container, volumeMounts: spec.mounts }
    : container;

  const initContainersList: Record<string, unknown>[] = [];
  if (passwordResetContainer) {
    // Inject env vars so the reset script can read $MARIADB_ROOT_PASSWORD etc.
    initContainersList.push({ ...passwordResetContainer, ...(envVars?.length ? { env: envVars } : {}) });
  }
  if (spec) initContainersList.push(spec.initDirsContainer);
  const initContainers = initContainersList.length > 0 ? initContainersList : undefined;

  const podSpec: Record<string, unknown> = {
    ...(initContainers ? { initContainers } : {}),
    containers: [containerWithMounts],
    ...(spec ? { volumes: spec.podVolumes } : {}),
  };
  if (workerNodeName) {
    if (storageTier === 'ha') {
      // HA tier: soft preference. Pod prefers the pin node for locality
      // but k8s is free to schedule elsewhere when that node is
      // NotReady — so the pod can fail over to a node holding the
      // surviving replica.
      podSpec.affinity = {
        nodeAffinity: {
          preferredDuringSchedulingIgnoredDuringExecution: [{
            weight: 100,
            preference: {
              matchExpressions: [{
                key: 'kubernetes.io/hostname',
                operator: 'In',
                values: [workerNodeName],
              }],
            },
          }],
        },
      };
    } else {
      // Local tier (or unset → defaults to local semantics): hard pin.
      // The single replica only exists here, so the pod must run here.
      podSpec.nodeSelector = { 'kubernetes.io/hostname': workerNodeName };
    }
  }

  // Pod-template metadata: labels are mandatory for the selector; annotations
  // are conditional so non-firewall apps render a clean Pod spec.
  const templateMetadata: Record<string, unknown> = { labels };
  if (podAnnotations && Object.keys(podAnnotations).length > 0) {
    templateMetadata.annotations = { ...podAnnotations };
  }

  const body = {
    metadata: { name, namespace, labels },
    spec: {
      replicas: replicaCount,
      selector: { matchLabels: selectorLabels },
      // Recreate (kill old before new) is mandatory for tenant workloads
      // because the storage PVC is RWO. Default RollingUpdate with
      // maxSurge=25% allows a new pod to spin up alongside the old one,
      // and the new pod gets stuck in Multi-Attach because the old pod
      // still holds the volume. This deadlock is observable as
      // "Init:0/1" persisting across restarts. Stateful pods (DB,
      // anything backed by a single PVC) must use Recreate.
      strategy: { type: 'Recreate' },
      template: {
        metadata: templateMetadata,
        spec: podSpec,
      },
    },
  } as Record<string, unknown>;

  try {
    await k8s.apps.createNamespacedDeployment({ namespace, body } as Parameters<typeof k8s.apps.createNamespacedDeployment>[0]);
  } catch (err: unknown) {
    if (isK8s409(err)) {
      await k8s.apps.replaceNamespacedDeployment({ name, namespace, body } as Parameters<typeof k8s.apps.replaceNamespacedDeployment>[0]);
    } else {
      throw err;
    }
  }
}

async function deployK8sCronJob(
  k8s: K8sClients,
  namespace: string,
  name: string,
  labels: Record<string, string>,
  container: Record<string, unknown>,
  schedule: string,
  storagePath: string = '',
  volumes: Array<{ container_path: string; local_path?: string | null }> = [],
): Promise<void> {
  const spec = buildVolumeMountSpec(volumes, storagePath, namespace);
  const containerWithMounts = spec ? { ...container, volumeMounts: spec.mounts } : container;
  const initContainers = spec ? [spec.initDirsContainer] : undefined;

  const body = {
    metadata: { name, namespace, labels },
    spec: {
      schedule,
      jobTemplate: {
        metadata: { labels },
        spec: {
          template: {
            metadata: { labels },
            spec: {
              ...(initContainers ? { initContainers } : {}),
              containers: [containerWithMounts],
              restartPolicy: 'OnFailure',
              ...(spec ? { volumes: spec.podVolumes } : {}),
            },
          },
        },
      },
    },
  };

  try {
    await (k8s as unknown as { batch: { createNamespacedCronJob: (args: Record<string, unknown>) => Promise<void> } }).batch.createNamespacedCronJob({ namespace, body });
  } catch (err: unknown) {
    if (isK8s409(err)) {
      await (k8s as unknown as { batch: { replaceNamespacedCronJob: (args: Record<string, unknown>) => Promise<void> } }).batch.replaceNamespacedCronJob({ name, namespace, body });
    } else {
      throw err;
    }
  }
}

async function deployK8sJob(
  k8s: K8sClients,
  namespace: string,
  name: string,
  labels: Record<string, string>,
  container: Record<string, unknown>,
  storagePath: string = '',
  volumes: Array<{ container_path: string; local_path?: string | null }> = [],
): Promise<void> {
  const spec = buildVolumeMountSpec(volumes, storagePath, namespace);
  const containerWithMounts = spec ? { ...container, volumeMounts: spec.mounts } : container;
  const initContainers = spec ? [spec.initDirsContainer] : undefined;

  const body = {
    metadata: { name, namespace, labels },
    spec: {
      template: {
        metadata: { labels },
        spec: {
          ...(initContainers ? { initContainers } : {}),
          containers: [containerWithMounts],
          restartPolicy: 'Never',
          ...(spec ? { volumes: spec.podVolumes } : {}),
        },
      },
      backoffLimit: 3,
    },
  };

  try {
    await (k8s as unknown as { batch: { createNamespacedJob: (args: Record<string, unknown>) => Promise<void> } }).batch.createNamespacedJob({ namespace, body });
  } catch (err: unknown) {
    if (isK8s409(err)) {
      // Jobs cannot be updated; ignore conflict
    } else {
      throw err;
    }
  }
}

async function deployK8sService(
  k8s: K8sClients,
  namespace: string,
  name: string,
  labels: Record<string, string>,
  ports: Array<{ port: number; protocol: string; ingress?: boolean }>,
): Promise<void> {
  const svcPorts = ports.map((p, i) => ({
    name: `port-${i}`,
    port: p.port,
    targetPort: p.port,
    protocol: p.protocol.toUpperCase() === 'UDP' ? 'UDP' as const : 'TCP' as const,
  }));

  const body = {
    metadata: { name, namespace, labels },
    spec: {
      type: 'ClusterIP',
      selector: { app: labels.app, component: labels.component },
      ports: svcPorts,
    },
  };

  try {
    await k8s.core.createNamespacedService({ namespace, body });
  } catch (err: unknown) {
    if (isK8s409(err)) {
      await k8s.core.deleteNamespacedService({ name, namespace });
      await k8s.core.createNamespacedService({ namespace, body });
    } else {
      throw err;
    }
  }
}

// ─── Stop (scale to 0 / suspend) ───────────────────────────────────────────

export async function stopDeployment(
  k8s: K8sClients,
  namespace: string,
  deploymentName: string,
  components: readonly DeployComponentInput[],
): Promise<void> {
  const componentCount = components.length;

  for (const component of components) {
    const name = k8sResourceName(deploymentName, component.name, componentCount);

    try {
      if (component.type === 'deployment' || component.type === 'statefulset') {
        // Read current scale, set replicas to 0, replace
        const current = await k8s.apps.readNamespacedDeploymentScale({ name, namespace });
        const scale = current as { metadata?: Record<string, unknown>; spec?: Record<string, unknown> };
        await k8s.apps.replaceNamespacedDeploymentScale({
          name,
          namespace,
          body: { ...scale, spec: { ...scale.spec, replicas: 0 } },
        } as Parameters<typeof k8s.apps.replaceNamespacedDeploymentScale>[0]);
      }
    } catch (err: unknown) {
      console.error(`[k8s-deployer] Failed to stop ${name}:`, err instanceof Error ? err.message : String(err));
      if (!isK8s404(err)) throw err;
    }
  }
}

// ─── Start (scale back up / resume) ─────────────────────────────────────────

export async function startDeployment(
  k8s: K8sClients,
  namespace: string,
  deploymentName: string,
  components: readonly DeployComponentInput[],
  replicas: number,
): Promise<void> {
  const componentCount = components.length;

  for (const component of components) {
    const name = k8sResourceName(deploymentName, component.name, componentCount);

    try {
      if (component.type === 'deployment' || component.type === 'statefulset') {
        const current = await k8s.apps.readNamespacedDeploymentScale({ name, namespace });
        const scale = current as { metadata?: Record<string, unknown>; spec?: Record<string, unknown> };
        await k8s.apps.replaceNamespacedDeploymentScale({
          name,
          namespace,
          body: { ...scale, spec: { ...scale.spec, replicas } },
        } as Parameters<typeof k8s.apps.replaceNamespacedDeploymentScale>[0]);
      } else if (component.type === 'cronjob') {
        await (k8s as unknown as { batch: { patchNamespacedCronJob: (args: Record<string, unknown>, mw: typeof STRATEGIC_MERGE_PATCH) => Promise<void> } }).batch.patchNamespacedCronJob({
          name,
          namespace,
          body: { spec: { suspend: false } },
        }, STRATEGIC_MERGE_PATCH);
      }
    } catch (err: unknown) {
      if (!isK8s404(err)) throw err;
    }
  }
}

// ─── Restart (rolling restart via annotation) ───────────────────────────────

export async function restartDeployment(
  k8s: K8sClients,
  namespace: string,
  deploymentName: string,
  components: readonly DeployComponentInput[],
): Promise<void> {
  // Restart by deleting pods — the Deployment controller will recreate them
  const componentCount = components.length;

  for (const component of components) {
    if (component.type === 'cronjob' || component.type === 'job') continue;

    const name = k8sResourceName(deploymentName, component.name, componentCount);

    try {
      // Find all pods owned by this component
      const pods = await k8s.core.listNamespacedPod({
        namespace,
        labelSelector: `app=${deploymentName},component=${component.name}`,
      });

      const podList = (pods as { items?: Array<{ metadata?: { name?: string } }> }).items ?? [];

      // Delete each pod — the controller will recreate them
      for (const pod of podList) {
        const podName = pod.metadata?.name;
        if (podName) {
          try {
            await k8s.core.deleteNamespacedPod({ name: podName, namespace });
          } catch (err: unknown) {
            if (!isK8s404(err)) throw err;
          }
        }
      }

      // If no pods found by label, try by resource name prefix
      if (podList.length === 0) {
        const allPods = await k8s.core.listNamespacedPod({ namespace });
        const matchingPods = ((allPods as { items?: Array<{ metadata?: { name?: string } }> }).items ?? [])
          .filter(p => p.metadata?.name?.startsWith(name));

        for (const pod of matchingPods) {
          const podName = pod.metadata?.name;
          if (podName) {
            try {
              await k8s.core.deleteNamespacedPod({ name: podName, namespace });
            } catch (err: unknown) {
              if (!isK8s404(err)) throw err;
            }
          }
        }
      }
    } catch (err: unknown) {
      if (!isK8s404(err)) throw err;
    }
  }
}

// ─── Delete ─────────────────────────────────────────────────────────────────

export async function deleteDeploymentResources(
  k8s: K8sClients,
  namespace: string,
  deploymentName: string,
  components: readonly DeployComponentInput[],
): Promise<void> {
  const componentCount = components.length;

  for (const component of components) {
    const name = k8sResourceName(deploymentName, component.name, componentCount);

    try {
      if (component.type === 'deployment' || component.type === 'statefulset') {
        await k8s.apps.deleteNamespacedDeployment({ name, namespace });
      } else if (component.type === 'cronjob') {
        await (k8s as unknown as { batch: { deleteNamespacedCronJob: (args: Record<string, unknown>) => Promise<void> } }).batch.deleteNamespacedCronJob({ name, namespace });
      } else if (component.type === 'job') {
        await (k8s as unknown as { batch: { deleteNamespacedJob: (args: Record<string, unknown>) => Promise<void> } }).batch.deleteNamespacedJob({ name, namespace });
      }
    } catch (err: unknown) {
      if (!isK8s404(err)) throw err;
    }

    // Delete associated Service
    if (component.ports.length > 0 && component.type !== 'cronjob' && component.type !== 'job') {
      try {
        await k8s.core.deleteNamespacedService({ name, namespace });
      } catch (err: unknown) {
        if (!isK8s404(err)) throw err;
      }
    }
  }
}

// ─── Status ─────────────────────────────────────────────────────────────────

export async function getDeploymentStatus(
  k8s: K8sClients,
  namespace: string,
  deploymentName: string,
  components: readonly DeployComponentInput[],
): Promise<AggregateDeploymentStatus> {
  const componentCount = components.length;
  const componentStatuses: ComponentPodStatus[] = [];

  for (const component of components) {
    const name = k8sResourceName(deploymentName, component.name, componentCount);

    if (component.type === 'deployment' || component.type === 'statefulset') {
      const status = await getK8sDeploymentStatus(k8s, namespace, name, deploymentName, component.name);
      componentStatuses.push(status);
    } else if (component.type === 'cronjob') {
      // CronJobs are either suspended or active
      componentStatuses.push({
        name: component.name,
        type: 'cronjob',
        phase: 'running',
        ready: true,
      });
    } else {
      componentStatuses.push({
        name: component.name,
        type: component.type,
        phase: 'running',
        ready: true,
      });
    }
  }

  // Aggregate status: failed if any non-optional component failed, running if all ready
  const requiredComponents = componentStatuses.filter((cs, i) => !components[i].optional);

  let aggregatePhase: AggregateDeploymentStatus['phase'] = 'running';
  let aggregateReady = true;

  if (requiredComponents.some(c => c.phase === 'failed')) {
    aggregatePhase = 'failed';
    aggregateReady = false;
  } else if (requiredComponents.some(c => c.phase === 'not_deployed')) {
    aggregatePhase = 'not_deployed';
    aggregateReady = false;
  } else if (requiredComponents.some(c => c.phase === 'stopped')) {
    aggregatePhase = 'stopped';
    aggregateReady = false;
  } else if (requiredComponents.some(c => c.phase === 'starting')) {
    aggregatePhase = 'starting';
    aggregateReady = false;
  }

  return {
    phase: aggregatePhase,
    ready: aggregateReady,
    components: componentStatuses,
  };
}

/**
 * Parses a Kubernetes "exceeded quota" event message into a human-readable
 * form that names the exhausted resource.
 *
 * K8s format (may contain multiple resources separated by commas):
 *   exceeded quota: <quota-name>, requested: limits.cpu=500m, used: limits.cpu=500m, limited: limits.cpu=500m
 *
 * Output example:
 *   Quota exceeded — CPU limit: requested 500m, using 500m of 500m.
 *   Free up resources or upgrade the plan.
 */
function formatQuotaExceededMessage(raw: string): string {
  const LABEL_MAP: Record<string, string> = {
    'limits.cpu': 'CPU limit',
    'limits.memory': 'memory limit',
    'requests.cpu': 'CPU request',
    'requests.memory': 'memory request',
    'requests.storage': 'storage request',
    'count/pods': 'pod count',
    'count/services': 'service count',
    'persistentvolumeclaims': 'PVC count',
  };

  // Extract key=value pairs from a "requested: …" / "used: …" / "limited: …" section.
  const parseSection = (label: string): Record<string, string> => {
    const m = raw.match(new RegExp(`${label}:\\s*([^,]+(?:,[^,]+(?:=)[^,]+)*)`));
    if (!m) return {};
    const out: Record<string, string> = {};
    for (const pair of m[1].split(/,\s*/)) {
      const [k, v] = pair.split('=');
      if (k && v) out[k.trim()] = v.trim();
    }
    return out;
  };

  const requested = parseSection('requested');
  const used = parseSection('used');
  const limited = parseSection('limited');

  const parts: string[] = [];
  for (const key of Object.keys(requested)) {
    const label = LABEL_MAP[key] ?? key;
    const req = requested[key];
    const cur = used[key];
    const lim = limited[key];
    if (req && cur && lim) {
      parts.push(`${label}: requesting ${req}, already using ${cur} of ${lim} limit`);
    } else if (req && lim) {
      parts.push(`${label}: requesting ${req}, limit is ${lim}`);
    } else {
      parts.push(`${label}: ${req}`);
    }
  }

  const detail = parts.length > 0 ? parts.join('; ') : raw;
  return `Quota exceeded — ${detail}. Free up resources or upgrade the plan.`;
}

async function getK8sDeploymentStatus(
  k8s: K8sClients,
  namespace: string,
  name: string,
  baseName: string,
  componentName: string,
): Promise<ComponentPodStatus> {
  let deployment: Record<string, unknown> | null = null;
  try {
    deployment = await k8s.apps.readNamespacedDeployment({ name, namespace }) as Record<string, unknown>;
  } catch (err: unknown) {
    if (isK8s404(err)) return { name: componentName, type: 'deployment', phase: 'not_deployed', ready: false };
    throw err;
  }

  const spec = (deployment as { spec?: { replicas?: number } }).spec;
  const status = (deployment as { status?: { replicas?: number; readyReplicas?: number } }).status;
  const desiredReplicas = spec?.replicas ?? 1;
  const readyReplicas = status?.readyReplicas ?? 0;

  if (desiredReplicas === 0) {
    return { name: componentName, type: 'deployment', phase: 'stopped', ready: false };
  }

  // Check for pod failures — use baseName for app label selector
  type PodItem = {
    spec?: {
      nodeName?: string;
    };
    status?: {
      phase?: string;
      conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
      containerStatuses?: Array<{ state?: { waiting?: { reason?: string; message?: string }; terminated?: { reason?: string; message?: string; exitCode?: number } } }>;
    };
  };
  const pods = await k8s.core.listNamespacedPod({ namespace, labelSelector: `app=${baseName}` });
  const podList = (pods as { items?: PodItem[] }).items ?? [];

  // First scheduled node — used by status-reconciler to populate
  // deployments.current_node_name for the admin UI's "host node" column.
  const nodeName = podList.find((p) => p.spec?.nodeName)?.spec?.nodeName ?? null;

  for (const pod of podList) {
    for (const cs of (pod.status?.containerStatuses ?? [])) {
      // Check waiting state (CrashLoopBackOff, ImagePullBackOff, etc.)
      const waitReason = cs.state?.waiting?.reason;
      if (waitReason === 'CrashLoopBackOff' || waitReason === 'ImagePullBackOff' || waitReason === 'ErrImagePull') {
        return {
          name: componentName,
          type: 'deployment',
          phase: 'failed',
          ready: false,
          message: `${waitReason}: ${cs.state?.waiting?.message ?? ''}`.trim(),
        };
      }

      // Check terminated state (OOMKilled, Error, etc.)
      const terminatedReason = cs.state?.terminated?.reason;
      if (terminatedReason === 'OOMKilled' || terminatedReason === 'Error') {
        const exitCode = cs.state?.terminated?.exitCode;
        const terminatedMsg = cs.state?.terminated?.message ?? '';
        const detail = exitCode !== undefined ? `exit code ${exitCode}` : '';
        const parts = [terminatedReason, terminatedMsg, detail].filter(Boolean);
        return {
          name: componentName,
          type: 'deployment',
          phase: 'failed',
          ready: false,
          message: parts.join(': ').trim(),
        };
      }
    }

    // Check Pending pods with no container statuses (PVC not found, Unschedulable, etc.)
    if (pod.status?.phase === 'Pending' && (!pod.status.containerStatuses || pod.status.containerStatuses.length === 0)) {
      const conditions = pod.status.conditions ?? [];
      const unschedulable = conditions.find(
        c => c.type === 'PodScheduled' && c.status === 'False',
      );
      if (unschedulable?.message) {
        return {
          name: componentName,
          type: 'deployment',
          phase: 'failed',
          ready: false,
          message: unschedulable.message,
        };
      }
    }
  }

  if (readyReplicas >= desiredReplicas) {
    return { name: componentName, type: 'deployment', phase: 'running', ready: true, nodeName };
  }

  // Check K8s events for FailedCreate (quota exceeded, etc.) and
  // Pod-level FailedAttachVolume — always check when not ready.
  //
  // FailedAttachVolume is the most common reason a tenant pod gets
  // stuck in Init: the Longhorn PVC can't attach because the volume
  // is detached/faulted (e.g. replica scheduling failed because no
  // node has enough free disk). The Pod is technically Scheduled and
  // PodScheduled=True, so the earlier unschedulable check above
  // returns nothing — without this branch the reconciler reports
  // `pending` with no detail until the 60-min stale timeout flips it
  // to `Timed out: No progress detected`. Surface it immediately.
  if (desiredReplicas > 0) {
    try {
      const events = await k8s.core.listNamespacedEvent({ namespace });
      const eventItems = (events as { items?: readonly {
        reason?: string;
        message?: string;
        type?: string;
        lastTimestamp?: string;
        involvedObject?: { kind?: string; name?: string };
      }[] }).items ?? [];

      // ReplicaSet quota / forbidden errors first (existing behavior).
      const failedEvent = eventItems.find(
        e => e.reason === 'FailedCreate' && e.involvedObject?.kind === 'ReplicaSet' && e.involvedObject?.name?.startsWith(name),
      );
      if (failedEvent?.message) {
        const msg = failedEvent.message;
        if (msg.includes('exceeded quota')) {
          return { name: componentName, type: 'deployment', phase: 'failed', ready: false,
            message: formatQuotaExceededMessage(msg) };
        }
        return { name: componentName, type: 'deployment', phase: 'failed', ready: false, message: msg };
      }

      // Pod-level volume / image / config errors. We classify a few
      // well-known reasons to user-friendly text, fall through to
      // the raw event message for everything else.
      const podName = podList[0] && (podList[0] as { metadata?: { name?: string } }).metadata?.name;
      const podEvents = podName
        ? eventItems.filter(e => e.involvedObject?.kind === 'Pod' && e.involvedObject?.name === podName)
        : eventItems.filter(e => e.involvedObject?.kind === 'Pod');
      const volEvent = podEvents.find(e => e.reason === 'FailedAttachVolume' || e.reason === 'FailedMount');
      if (volEvent?.message) {
        const msg = volEvent.message;
        if (msg.includes('not ready for workloads') || msg.includes('faulted')) {
          return {
            name: componentName,
            type: 'deployment',
            phase: 'failed',
            ready: false,
            message: 'Storage volume is faulted: replica scheduling failed (likely insufficient free disk on cluster nodes). Operator action required.',
          };
        }
        if (msg.includes('insufficient storage')) {
          return {
            name: componentName,
            type: 'deployment',
            phase: 'failed',
            ready: false,
            message: 'Storage scheduling failed: no cluster node has enough free disk for the requested volume.',
          };
        }
        return {
          name: componentName,
          type: 'deployment',
          phase: 'failed',
          ready: false,
          message: `Volume attach failed: ${msg.slice(0, 240)}`,
        };
      }
      const imgEvent = podEvents.find(e => e.reason === 'Failed' || e.reason === 'BackOff');
      if (imgEvent?.message?.match(/(ImagePull|manifest unknown|denied)/i)) {
        return {
          name: componentName,
          type: 'deployment',
          phase: 'failed',
          ready: false,
          message: `Image pull error: ${imgEvent.message.slice(0, 240)}`,
        };
      }
    } catch { /* events not available */ }
  }

  return {
    name: componentName,
    type: 'deployment',
    phase: 'starting',
    ready: false,
    message: `${readyReplicas}/${desiredReplicas} replicas ready`,
    nodeName,
  };
}

