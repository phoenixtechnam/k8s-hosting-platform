/**
 * cluster-trusted-proxies reconciler.
 *
 * Inputs:
 *   - DB rows from cluster_trusted_proxy_ranges (operator + bootstrap)
 *   - platform_settings rows for bootstrap CIDRs (auto-seeded each tick)
 *
 * Outputs (idempotent):
 *   1. ConfigMap `platform/cluster-trusted-proxies` —
 *        data['trusted-proxies.conf'] = nginx snippet
 *          (one `set_real_ip_from <cidr>;` per line)
 *        data['trusted-proxies.csv']  = csv for human ops/debug
 *        data['hash']                  = sha256 of CSV for annotation
 *      Mounted by admin-panel + tenant-panel pods at
 *      /etc/nginx/conf.d/trusted-proxies.d/ — each ConfigMap key
 *      becomes a file. nginx's include glob picks up trusted-proxies.conf.
 *
 *   2. Traefik DS args — JSON-patch the
 *      `--entryPoints.web.forwardedHeaders.trustedIPs=<csv>` and
 *      `--entryPoints.websecure.forwardedHeaders.trustedIPs=<csv>`
 *      args. If an arg already exists at some index, REPLACE that
 *      element; if missing, APPEND with op:add and path:'/.../-'.
 *      Always includes `127.0.0.1/32` as the baseline so loopback
 *      probes still work.
 *
 *   3. admin-panel + tenant-panel Deployments — stamp pod-template
 *      annotation `platform.phoenix-host.net/trusted-proxies-hash`
 *      with the ConfigMap CSV hash so a content change triggers a
 *      rolling restart (nginx re-reads `/etc/nginx/conf.d/trusted-
 *      proxies.d/*.conf` on start).
 *
 * Concurrency: this reconciler runs on a 5-min scheduler tick PLUS
 * an inline call from POST/DELETE routes for instant convergence.
 * setImmediate-only inline calls (not awaited) so PATCH responses
 * stay snappy; the scheduler's next tick covers any inline failures.
 */

import { createHash } from 'node:crypto';
import * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';
import {
  createTrustedProxyRangeRequestSchema,
} from '@k8s-hosting/api-contracts';
import type { Database } from '../../db/index.js';
import { JSON_PATCH, MERGE_PATCH } from '../../shared/k8s-patch.js';
import { listMaterialisedCidrs, upsertBootstrapRange } from './service.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const CONFIGMAP_NAMESPACE = 'platform';
const CONFIGMAP_NAME = 'cluster-trusted-proxies';
const TRAEFIK_NAMESPACE = 'traefik';
const TRAEFIK_DS_NAME = 'traefik';
const TRAEFIK_BASELINE_TRUST = '127.0.0.1/32';
const TRUST_ARG_PREFIX_WEB = '--entryPoints.web.forwardedHeaders.trustedIPs=';
const TRUST_ARG_PREFIX_SECURE = '--entryPoints.websecure.forwardedHeaders.trustedIPs=';
const PANEL_DEPLOYMENTS: ReadonlyArray<{ name: string; namespace: string }> = [
  { name: 'admin-panel', namespace: 'platform' },
  { name: 'tenant-panel', namespace: 'platform' },
];
const ANNOTATION_KEY = 'platform.phoenix-host.net/trusted-proxies-hash';
/**
 * Bootstrap-CIDR source: ConfigMap `platform/platform-cluster-cidrs`
 * with keys POD_CIDR and SVC_CIDR. Written by bootstrap.sh on cluster
 * init (the values it passed to k3s as --cluster-cidr / --service-cidr).
 * Absent on older clusters / dev — reconciler skips silently.
 */
const CLUSTER_CIDRS_CM_NAMESPACE = 'platform';
const CLUSTER_CIDRS_CM_NAME = 'platform-cluster-cidrs';

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

/**
 * Render nginx snippet from CIDR list. Stable ordering for deterministic
 * hash so the panel-Deployment annotation hash only changes when the
 * CIDR set itself changes.
 *
 * SECURITY: ONLY the CIDR is emitted into the snippet. The description
 * field is deliberately NEVER included — even though Zod rejects
 * special characters (newlines, semicolons, comments, braces), the
 * defence-in-depth rule is: don't put operator-input strings inside a
 * config-language file that nginx parses. If you change this to add
 * the description (or any other field), revalidate the Zod regex AND
 * add an nginx-config-injection test.
 */
export function renderNginxSnippet(cidrs: ReadonlyArray<string>): string {
  if (cidrs.length === 0) {
    return '# (no operator-managed trusted proxies)\n';
  }
  const sorted = [...cidrs].sort();
  return (
    '# Operator-managed trusted upstream proxies — DO NOT EDIT\n' +
    '# Reconciled from cluster_trusted_proxy_ranges + platform_settings\n' +
    sorted.map((c) => `set_real_ip_from ${c};`).join('\n') +
    '\n'
  );
}

/** Render CSV used for Traefik trustedIPs args + ConfigMap data['trusted-proxies.csv']. */
export function renderTraefikCsv(cidrs: ReadonlyArray<string>): string {
  const sorted = [...cidrs].sort();
  return [TRAEFIK_BASELINE_TRUST, ...sorted].join(',');
}

/** sha256 of CSV — used for ConfigMap data['hash'] + pod-template annotation. */
export function renderHash(csv: string): string {
  return createHash('sha256').update(csv).digest('hex').slice(0, 16);
}

/**
 * Build a JSON-patch op list that REPLACES the trustedIPs args in
 * Traefik DS containers[0].args. Caller must read the current args
 * to determine indices. If an arg doesn't exist yet, it's appended.
 *
 * Ordering: all replace ops first (index-stable), then appends with
 * path '/-'. This way the index-based replaces don't shift mid-batch.
 */
export interface TraefikPatchOp {
  op: 'replace' | 'add';
  path: string;
  value: string;
}
export function buildTraefikPatchOps(
  currentArgs: ReadonlyArray<string>,
  csv: string,
): TraefikPatchOp[] {
  const ops: TraefikPatchOp[] = [];
  const desired: ReadonlyArray<readonly [string, string]> = [
    [TRUST_ARG_PREFIX_WEB, `${TRUST_ARG_PREFIX_WEB}${csv}`],
    [TRUST_ARG_PREFIX_SECURE, `${TRUST_ARG_PREFIX_SECURE}${csv}`],
  ];
  const appends: TraefikPatchOp[] = [];
  for (const [prefix, full] of desired) {
    const idx = currentArgs.findIndex((a) => a.startsWith(prefix));
    if (idx >= 0) {
      if (currentArgs[idx] === full) continue; // already matches → no-op
      ops.push({
        op: 'replace',
        path: `/spec/template/spec/containers/0/args/${idx}`,
        value: full,
      });
    } else {
      appends.push({
        op: 'add',
        path: '/spec/template/spec/containers/0/args/-',
        value: full,
      });
    }
  }
  return [...ops, ...appends];
}

// ─── K8s applier (impure) ────────────────────────────────────────────────────

export interface ReconcileClients {
  readonly core: k8s.CoreV1Api;
  readonly apps: k8s.AppsV1Api;
}

export interface ReconcileResult {
  readonly cidrCount: number;
  readonly configMapChanged: boolean;
  readonly traefikChanged: boolean;
  readonly panelsRolled: number;
  readonly hash: string;
}

export async function reconcileClusterTrustedProxies(
  db: Database,
  clients: ReconcileClients,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<ReconcileResult> {
  // Step 1: auto-seed bootstrap CIDRs from platform-cluster-cidrs CM (idempotent).
  await seedBootstrapCidrs(db, clients.core, log);

  // Step 2: read materialised CIDRs (bootstrap + operator).
  const cidrs = await listMaterialisedCidrs(db);
  const snippet = renderNginxSnippet(cidrs);
  const csv = renderTraefikCsv(cidrs);
  const hash = renderHash(csv);

  // Step 3: write ConfigMap.
  const configMapChanged = await upsertConfigMap(
    clients.core,
    snippet,
    csv,
    hash,
    log,
  );

  // Step 4: patch Traefik DS args.
  const traefikChanged = await patchTraefikDsArgs(clients.apps, csv, log);

  // Step 5: stamp pod-template annotations on admin-panel + tenant-panel.
  let panelsRolled = 0;
  for (const dep of PANEL_DEPLOYMENTS) {
    const rolled = await stampDeploymentAnnotation(
      clients.apps,
      dep.namespace,
      dep.name,
      hash,
      log,
    );
    if (rolled) panelsRolled++;
  }

  return {
    cidrCount: cidrs.length,
    configMapChanged,
    traefikChanged,
    panelsRolled,
    hash,
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

async function seedBootstrapCidrs(
  db: Database,
  core: k8s.CoreV1Api,
  log: Pick<Logger, 'info' | 'warn'>,
): Promise<void> {
  // Read POD_CIDR + SVC_CIDR from the platform-cluster-cidrs ConfigMap
  // written by bootstrap.sh. Absent on older / dev clusters — skip silently.
  let data: Record<string, string> | undefined;
  try {
    const cm = (await core.readNamespacedConfigMap({
      name: CLUSTER_CIDRS_CM_NAME,
      namespace: CLUSTER_CIDRS_CM_NAMESPACE,
    } as unknown as Parameters<typeof core.readNamespacedConfigMap>[0])) as unknown as {
      data?: Record<string, string>;
    };
    data = cm.data;
  } catch (err) {
    const e = err as { code?: unknown; statusCode?: unknown };
    const is404 = e.code === 404 || e.statusCode === 404;
    if (!is404) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'cluster-trusted-proxies: bootstrap-CIDR ConfigMap read failed (non-fatal)',
      );
    }
    return;
  }
  const pairs: ReadonlyArray<readonly [string | undefined, string]> = [
    [data?.POD_CIDR, 'k3s pod CIDR (auto-detected at bootstrap)'],
    [data?.SVC_CIDR, 'k3s service CIDR (auto-detected at bootstrap)'],
  ];
  for (const [value, desc] of pairs) {
    if (!value) continue;
    // Validate the bootstrap value through the same Zod schema operator
    // inputs go through. Defence in depth: a tampered ConfigMap (any
    // pod with configmaps:patch in the platform namespace can mutate
    // it) MUST NOT smuggle arbitrary strings into the trust ConfigMap.
    const parsed = createTrustedProxyRangeRequestSchema.safeParse({
      cidr: value,
      description: desc,
    });
    if (!parsed.success) {
      log.warn(
        { value, reason: parsed.error.issues.map((i) => i.message).join('; ') },
        'cluster-trusted-proxies: bootstrap CIDR rejected by Zod (skipping)',
      );
      continue;
    }
    try {
      await upsertBootstrapRange(db, parsed.data.cidr, parsed.data.description);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), cidr: value },
        'cluster-trusted-proxies: bootstrap upsert failed (non-fatal)',
      );
    }
  }
}

async function upsertConfigMap(
  core: k8s.CoreV1Api,
  snippet: string,
  csv: string,
  hash: string,
  log: Pick<Logger, 'info' | 'warn'>,
): Promise<boolean> {
  const desiredData = {
    'trusted-proxies.conf': snippet,
    'trusted-proxies.csv': csv,
    hash,
  };
  try {
    const current = (await core.readNamespacedConfigMap({
      name: CONFIGMAP_NAME,
      namespace: CONFIGMAP_NAMESPACE,
    } as unknown as Parameters<typeof core.readNamespacedConfigMap>[0])) as unknown as {
      data?: Record<string, string>;
    };
    const sameHash = current.data?.hash === hash;
    if (sameHash) return false;
    await core.patchNamespacedConfigMap(
      {
        name: CONFIGMAP_NAME,
        namespace: CONFIGMAP_NAMESPACE,
        body: { data: desiredData },
      } as unknown as Parameters<typeof core.patchNamespacedConfigMap>[0],
      MERGE_PATCH,
    );
    log.info({ hash }, 'cluster-trusted-proxies: ConfigMap updated');
    return true;
  } catch (err) {
    const e = err as { code?: unknown; statusCode?: unknown };
    const is404 = e.code === 404 || e.statusCode === 404;
    if (!is404) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'cluster-trusted-proxies: ConfigMap read failed',
      );
      throw err;
    }
    try {
      await core.createNamespacedConfigMap({
        namespace: CONFIGMAP_NAMESPACE,
        body: {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: {
            name: CONFIGMAP_NAME,
            namespace: CONFIGMAP_NAMESPACE,
            labels: { 'app.kubernetes.io/managed-by': 'platform-api' },
          },
          data: desiredData,
        },
      } as unknown as Parameters<typeof core.createNamespacedConfigMap>[0]);
      log.info({ hash }, 'cluster-trusted-proxies: ConfigMap created');
      return true;
    } catch (createErr) {
      // Read-create races: a concurrent reconciler tick (or Flux apply
      // of the stub) created the ConfigMap between our read-404 and
      // our create. Fall through to PATCH so we converge cleanly.
      const ce = createErr as { code?: unknown; statusCode?: unknown };
      const is409 = ce.code === 409 || ce.statusCode === 409;
      if (!is409) throw createErr;
      await core.patchNamespacedConfigMap(
        {
          name: CONFIGMAP_NAME,
          namespace: CONFIGMAP_NAMESPACE,
          body: { data: desiredData },
        } as unknown as Parameters<typeof core.patchNamespacedConfigMap>[0],
        MERGE_PATCH,
      );
      log.info({ hash }, 'cluster-trusted-proxies: ConfigMap created via 409→PATCH');
      return true;
    }
  }
}

async function patchTraefikDsArgs(
  apps: k8s.AppsV1Api,
  csv: string,
  log: Pick<Logger, 'info' | 'warn'>,
): Promise<boolean> {
  let currentArgs: string[];
  try {
    const ds = (await apps.readNamespacedDaemonSet({
      name: TRAEFIK_DS_NAME,
      namespace: TRAEFIK_NAMESPACE,
    } as unknown as Parameters<typeof apps.readNamespacedDaemonSet>[0])) as unknown as {
      spec?: { template?: { spec?: { containers?: Array<{ args?: string[] }> } } };
    };
    currentArgs = ds.spec?.template?.spec?.containers?.[0]?.args ?? [];
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'cluster-trusted-proxies: Traefik DS read failed (non-blocking)',
    );
    return false;
  }
  const ops = buildTraefikPatchOps(currentArgs, csv);
  if (ops.length === 0) return false;
  try {
    await apps.patchNamespacedDaemonSet(
      {
        name: TRAEFIK_DS_NAME,
        namespace: TRAEFIK_NAMESPACE,
        body: ops,
      } as unknown as Parameters<typeof apps.patchNamespacedDaemonSet>[0],
      JSON_PATCH,
    );
    log.info(
      { ops: ops.length, csv },
      'cluster-trusted-proxies: Traefik DS args patched',
    );
    return true;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'cluster-trusted-proxies: Traefik DS patch failed',
    );
    return false;
  }
}

async function stampDeploymentAnnotation(
  apps: k8s.AppsV1Api,
  namespace: string,
  name: string,
  hash: string,
  log: Pick<Logger, 'info' | 'warn'>,
): Promise<boolean> {
  try {
    const dep = (await apps.readNamespacedDeployment({
      name,
      namespace,
    } as unknown as Parameters<typeof apps.readNamespacedDeployment>[0])) as unknown as {
      spec?: { template?: { metadata?: { annotations?: Record<string, string> } } };
    };
    const current = dep.spec?.template?.metadata?.annotations?.[ANNOTATION_KEY];
    if (current === hash) return false;
    await apps.patchNamespacedDeployment(
      {
        name,
        namespace,
        body: {
          spec: { template: { metadata: { annotations: { [ANNOTATION_KEY]: hash } } } },
        },
      } as unknown as Parameters<typeof apps.patchNamespacedDeployment>[0],
      MERGE_PATCH,
    );
    log.info({ name, hash }, 'cluster-trusted-proxies: Deployment annotation stamped');
    return true;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), name },
      'cluster-trusted-proxies: Deployment annotation patch failed (non-blocking)',
    );
    return false;
  }
}

// ─── Pod-roll status helper (for GET response) ───────────────────────────────

export async function countPanelPodsRolled(
  apps: k8s.AppsV1Api,
  core: k8s.CoreV1Api,
  hash: string,
  log?: Pick<Logger, 'warn'>,
): Promise<{ rolled: number; total: number }> {
  let total = 0;
  let rolled = 0;
  for (const dep of PANEL_DEPLOYMENTS) {
    try {
      const pods = (await core.listNamespacedPod({
        namespace: dep.namespace,
        labelSelector: `app=${dep.name}`,
      } as unknown as Parameters<typeof core.listNamespacedPod>[0])) as unknown as {
        items: Array<{
          metadata?: { annotations?: Record<string, string> };
          status?: { phase?: string };
        }>;
      };
      for (const p of pods.items ?? []) {
        if (p.status?.phase !== 'Running') continue;
        total++;
        if (p.metadata?.annotations?.[ANNOTATION_KEY] === hash) rolled++;
      }
    } catch (err) {
      // List failures here surface as "0/0 rolled" in the UI. Log
      // a warn so a persistent API failure is observable (not silent).
      log?.warn(
        { err: err instanceof Error ? err.message : String(err), name: dep.name },
        'cluster-trusted-proxies: pod-count list failed',
      );
    }
  }
  return { rolled, total };
}
