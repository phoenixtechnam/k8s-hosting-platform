/**
 * Differential secrets-bundle coverage audit (DR-bundle roadmap, Phase 0).
 *
 * Lists EVERY Secret in the cluster and classifies each into one of
 * five categories: `denied`, `tier-1-bundle`, `tier-2-tenant-sweep`,
 * `allowlisted`, or `uncovered`. The UNCOVERED set is the silent DR
 * risk this module exists to surface.
 *
 * Classifier rules (in priority order — first match wins):
 *
 *   1. DENIED — auto-managed by k8s/operators. NOT bundle candidates
 *      by design; restoring them would conflict with the owning
 *      controller. Examples:
 *        - type `kubernetes.io/service-account-token`
 *        - type `kubernetes.io/dockercfg` / `dockerconfigjson`
 *        - name prefix `sh.helm.release.v1.` (Helm release state)
 *        - ownerReference.kind = `Certificate` (cert-manager-issued TLS)
 *        - ownerReference.kind = `SealedSecret`
 *        - ownerReference.kind = `Cluster` AND apiVersion contains
 *          `postgresql.cnpg.io` (CNPG-managed cluster credentials)
 *
 *   2. TIER-1 BUNDLE — explicitly named in BUNDLE_SECRET_LIST.
 *      Covered by both the in-cluster exporter and the daily CronJob.
 *
 *   3. TIER-2 TENANT SWEEP — namespace matches `^client-.+` pattern.
 *      The nightly `platform-secrets-backup` CronJob sweeps every
 *      Secret in these namespaces by label selector.
 *
 *   4. ALLOWLISTED — operator-added entry in the
 *      `secrets-audit-allowlist` ConfigMap with a documented reason.
 *
 *   5. UNCOVERED — everything else. Silent DR risk.
 *
 * The result is computed on-demand (no DB persistence) with a short
 * cache to keep the operator UI responsive. Operator-triggered
 * "refresh" busts the cache.
 *
 * See docs/04-deployment/DR_BUNDLE_ROADMAP.md Phase 0 + 1.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  type AllowlistEntry,
  type AuditedSecret,
  type SecretCoverageCategory,
  type SecretsAuditResult,
} from '@k8s-hosting/api-contracts';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { BUNDLE_SECRET_LIST } from './secrets-bundle.js';

/** Where the operator-curated allowlist lives. */
export const ALLOWLIST_NAMESPACE = 'platform-system';
export const ALLOWLIST_CONFIGMAP_NAME = 'secrets-audit-allowlist';
/** Key inside the ConfigMap whose value is a YAML list of entries. */
const ALLOWLIST_DATA_KEY = 'allowlist.yaml';

/** Tenant namespace pattern. Mirrors the shell CronJob's selector. */
const TENANT_NAMESPACE_RE = /^client-.+$/;

/** Cache TTL — short, since the operator typically clicks Refresh
 *  while watching the page after fixing coverage gaps. */
const CACHE_TTL_MS = 30_000;

interface SecretListItem {
  readonly metadata?: {
    readonly namespace?: string;
    readonly name?: string;
    readonly creationTimestamp?: Date | string;
    readonly ownerReferences?: ReadonlyArray<{
      readonly apiVersion?: string;
      readonly kind?: string;
      readonly name?: string;
    }>;
  };
  readonly type?: string;
}

interface SecretList {
  readonly items?: ReadonlyArray<SecretListItem>;
}

let cached: { result: SecretsAuditResult; computedAt: number } | null = null;

/** Bust the cache. Called by the refresh endpoint. */
export function invalidateAuditCache(): void {
  cached = null;
}

/** Top-level: list secrets cluster-wide, read allowlist, classify, return. */
export async function runSecretsAudit(
  k8s: K8sClients,
  opts: { now?: () => Date; useCache?: boolean } = {},
): Promise<SecretsAuditResult> {
  const now = opts.now ?? (() => new Date());
  if (opts.useCache !== false && cached && now().getTime() - cached.computedAt < CACHE_TTL_MS) {
    return cached.result;
  }

  const [secretList, allowlist] = await Promise.all([
    listAllSecrets(k8s),
    readAllowlist(k8s),
  ]);

  const allowlistKey = (ns: string, name: string): string => `${ns}/${name}`;
  const allowlistMap = new Map<string, AllowlistEntry>();
  for (const entry of allowlist) {
    allowlistMap.set(allowlistKey(entry.namespace, entry.name), entry);
  }
  const bundleKeys = new Set(BUNDLE_SECRET_LIST.map((s) => allowlistKey(s.namespace, s.name)));

  const audited: AuditedSecret[] = [];
  for (const item of secretList) {
    const ns = item.metadata?.namespace ?? '';
    const name = item.metadata?.name ?? '';
    if (!ns || !name) continue;
    const type = item.type ?? 'Opaque';
    const createdAtRaw = item.metadata?.creationTimestamp;
    const createdAt = toIso(createdAtRaw);
    const ageSeconds = createdAt
      ? Math.max(0, Math.floor((now().getTime() - new Date(createdAt).getTime()) / 1000))
      : 0;
    const owner = item.metadata?.ownerReferences?.[0];
    const ownerKind = owner?.kind ?? null;
    const ownerName = owner?.name ?? null;

    const { category, reason } = classify({
      namespace: ns,
      name,
      type,
      owner: owner ?? null,
      bundleKeys,
      allowlistMap,
    });

    audited.push({
      namespace: ns,
      name,
      type,
      createdAt: createdAt ?? new Date(0).toISOString(),
      ageSeconds,
      ownerKind,
      ownerName,
      category,
      reason,
    });
  }

  const byCategory = {
    denied: 0,
    tier1Bundle: 0,
    tier2TenantSweep: 0,
    allowlisted: 0,
    uncovered: 0,
  };
  for (const a of audited) {
    switch (a.category) {
      case 'denied': byCategory.denied++; break;
      case 'tier-1-bundle': byCategory.tier1Bundle++; break;
      case 'tier-2-tenant-sweep': byCategory.tier2TenantSweep++; break;
      case 'allowlisted': byCategory.allowlisted++; break;
      case 'uncovered': byCategory.uncovered++; break;
    }
  }

  const result: SecretsAuditResult = {
    generatedAt: now().toISOString(),
    totalSecretsCount: audited.length,
    byCategory,
    healthy: byCategory.uncovered === 0,
    uncoveredSecrets: audited.filter((a) => a.category === 'uncovered'),
    allowlistedSecrets: audited.filter((a) => a.category === 'allowlisted'),
  };
  cached = { result, computedAt: now().getTime() };
  return result;
}

interface ClassifyInput {
  readonly namespace: string;
  readonly name: string;
  readonly type: string;
  readonly owner: { kind?: string; apiVersion?: string } | null;
  readonly bundleKeys: ReadonlySet<string>;
  readonly allowlistMap: ReadonlyMap<string, AllowlistEntry>;
}

/** Pure classifier — no IO. Exported for unit-testing the rule set. */
export function classify(input: ClassifyInput): { category: SecretCoverageCategory; reason: string } {
  const { namespace, name, type, owner, bundleKeys, allowlistMap } = input;

  // ── Rule 1: DENIED — auto-managed, not a bundle candidate ─────────
  if (type === 'kubernetes.io/service-account-token') {
    return { category: 'denied', reason: 'ServiceAccount token (auto-rotated by k8s)' };
  }
  if (type === 'kubernetes.io/dockercfg' || type === 'kubernetes.io/dockerconfigjson') {
    return { category: 'denied', reason: 'Docker registry pull-secret (auto-generated)' };
  }
  if (name.startsWith('sh.helm.release.v1.')) {
    return { category: 'denied', reason: 'Helm release state (recreatable from chart values)' };
  }
  if (owner) {
    const kind = owner.kind ?? '';
    const api = owner.apiVersion ?? '';
    if (kind === 'Certificate' && api.includes('cert-manager.io')) {
      return { category: 'denied', reason: 'cert-manager TLS (auto-issued from Certificate CR)' };
    }
    if (kind === 'SealedSecret') {
      return { category: 'denied', reason: 'unsealed copy owned by SealedSecret (regenerated from seal)' };
    }
    if (kind === 'Cluster' && api.includes('postgresql.cnpg.io')) {
      return { category: 'denied', reason: 'CNPG-managed (regenerated by the operator)' };
    }
  }

  // ── Rule 2: TIER-1 BUNDLE — explicit bundle inclusion ─────────────
  if (bundleKeys.has(`${namespace}/${name}`)) {
    return { category: 'tier-1-bundle', reason: 'BUNDLE_SECRET_LIST entry' };
  }

  // ── Rule 3: TIER-2 TENANT SWEEP — namespace pattern ───────────────
  if (TENANT_NAMESPACE_RE.test(namespace)) {
    return { category: 'tier-2-tenant-sweep', reason: 'tenant namespace (nightly CronJob sweep)' };
  }

  // ── Rule 4: ALLOWLISTED — operator-decided ────────────────────────
  if (allowlistMap.has(`${namespace}/${name}`)) {
    const entry = allowlistMap.get(`${namespace}/${name}`)!;
    return { category: 'allowlisted', reason: entry.reason };
  }

  // ── Rule 5: UNCOVERED — silent DR risk ────────────────────────────
  return { category: 'uncovered', reason: 'no rule matched — extend bundle or add to allowlist' };
}

// ─── K8s IO ────────────────────────────────────────────────────────────

async function listAllSecrets(k8s: K8sClients): Promise<SecretListItem[]> {
  const core = k8s.core as unknown as {
    listSecretForAllNamespaces: () => Promise<SecretList>;
  };
  const list = await core.listSecretForAllNamespaces();
  return [...(list.items ?? [])];
}

/** Read the allowlist ConfigMap. Returns [] if the CM doesn't exist
 *  yet (fresh cluster). Defensive about malformed YAML — logs + skips. */
export async function readAllowlist(k8s: K8sClients): Promise<AllowlistEntry[]> {
  const core = k8s.core as unknown as {
    readNamespacedConfigMap: (a: { namespace: string; name: string }) => Promise<{ data?: Record<string, string> }>;
  };
  let cm: { data?: Record<string, string> };
  try {
    cm = await core.readNamespacedConfigMap({
      namespace: ALLOWLIST_NAMESPACE,
      name: ALLOWLIST_CONFIGMAP_NAME,
    });
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code
      ?? (err as { statusCode?: number }).statusCode;
    if (code === 404) return [];
    throw err;
  }
  const raw = cm.data?.[ALLOWLIST_DATA_KEY];
  if (!raw) return [];
  try {
    const parsed = parseYaml(raw) as { entries?: ReadonlyArray<unknown> } | null;
    if (!parsed || !Array.isArray(parsed.entries)) return [];
    const out: AllowlistEntry[] = [];
    for (const e of parsed.entries) {
      const entry = e as Partial<AllowlistEntry>;
      if (
        typeof entry.namespace === 'string' &&
        typeof entry.name === 'string' &&
        typeof entry.reason === 'string' &&
        typeof entry.addedBy === 'string' &&
        typeof entry.addedAt === 'string'
      ) {
        out.push({
          namespace: entry.namespace,
          name: entry.name,
          reason: entry.reason,
          addedBy: entry.addedBy,
          addedAt: entry.addedAt,
        });
      }
    }
    return out;
  } catch (err) {
    // Corrupt YAML — treat as empty + log so the silent denial-of-
    // observability (every allowlisted Secret reappears as uncovered)
    // surfaces in platform-api logs and the audit-log middleware.
    // eslint-disable-next-line no-console
    console.warn('[secrets-audit] allowlist YAML parse failed; treating as empty', {
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export interface UpsertAllowlistInput {
  readonly namespace: string;
  readonly name: string;
  readonly reason: string;
  readonly addedBy: string;
  readonly now?: () => Date;
}

/** Add OR update an allowlist entry. Idempotent. */
export async function upsertAllowlistEntry(
  k8s: K8sClients,
  input: UpsertAllowlistInput,
): Promise<AllowlistEntry[]> {
  const now = input.now ?? (() => new Date());
  const current = await readAllowlist(k8s);
  const idx = current.findIndex(
    (e) => e.namespace === input.namespace && e.name === input.name,
  );
  const next: AllowlistEntry = {
    namespace: input.namespace,
    name: input.name,
    reason: input.reason,
    addedBy: input.addedBy,
    addedAt: idx >= 0 ? current[idx].addedAt : now().toISOString(),
  };
  const updated = idx >= 0
    ? [...current.slice(0, idx), next, ...current.slice(idx + 1)]
    : [...current, next];
  await writeAllowlist(k8s, updated);
  invalidateAuditCache();
  return updated;
}

/** Remove an allowlist entry by (namespace, name). No-op if absent. */
export async function removeAllowlistEntry(
  k8s: K8sClients,
  namespace: string,
  name: string,
): Promise<AllowlistEntry[]> {
  const current = await readAllowlist(k8s);
  const updated = current.filter((e) => !(e.namespace === namespace && e.name === name));
  if (updated.length === current.length) return current;
  await writeAllowlist(k8s, updated);
  invalidateAuditCache();
  return updated;
}

async function writeAllowlist(k8s: K8sClients, entries: AllowlistEntry[]): Promise<void> {
  const yamlBody = stringifyYaml({ entries });
  const core = k8s.core as unknown as {
    readNamespacedConfigMap: (a: { namespace: string; name: string }) => Promise<unknown>;
    createNamespacedConfigMap: (a: {
      namespace: string;
      body: { metadata: { name: string; namespace: string }; data: Record<string, string> };
    }) => Promise<unknown>;
    patchNamespacedConfigMap: (
      a: { namespace: string; name: string; body: { data: Record<string, string> } },
      ...rest: unknown[]
    ) => Promise<unknown>;
  };
  try {
    await core.readNamespacedConfigMap({
      namespace: ALLOWLIST_NAMESPACE,
      name: ALLOWLIST_CONFIGMAP_NAME,
    });
    // Exists — patch the data key.
    // STRATEGIC_MERGE_PATCH is the default for ConfigMap merges in
    // @kubernetes/client-node; MERGE_PATCH (RFC 7396) is the right
    // form for this {data: {key: value}} body.
    await core.patchNamespacedConfigMap(
      {
        namespace: ALLOWLIST_NAMESPACE,
        name: ALLOWLIST_CONFIGMAP_NAME,
        body: { data: { [ALLOWLIST_DATA_KEY]: yamlBody } },
      },
      MERGE_PATCH,
    );
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code
      ?? (err as { statusCode?: number }).statusCode;
    if (code !== 404) throw err;
    try {
      await core.createNamespacedConfigMap({
        namespace: ALLOWLIST_NAMESPACE,
        body: {
          metadata: { name: ALLOWLIST_CONFIGMAP_NAME, namespace: ALLOWLIST_NAMESPACE },
          data: { [ALLOWLIST_DATA_KEY]: yamlBody },
        },
      });
    } catch (createErr) {
      // TOCTOU: a concurrent caller raced us to Create. Patch instead.
      const createCode = (createErr as { code?: number; statusCode?: number }).code
        ?? (createErr as { statusCode?: number }).statusCode;
      if (createCode !== 409) throw createErr;
      await core.patchNamespacedConfigMap(
        {
          namespace: ALLOWLIST_NAMESPACE,
          name: ALLOWLIST_CONFIGMAP_NAME,
          body: { data: { [ALLOWLIST_DATA_KEY]: yamlBody } },
        },
        MERGE_PATCH,
      );
    }
  }
}

function toIso(d: Date | string | undefined): string | null {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString();
  return new Date(d).toISOString();
}
