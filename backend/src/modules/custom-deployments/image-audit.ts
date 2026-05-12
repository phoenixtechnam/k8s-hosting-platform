// Per-pull forensic audit: every distinct (deployment, image, digest)
// the kubelet observes lands in `custom_deployment_image_audit`. The
// digest is captured from `pod.status.containerStatuses[*].imageID`,
// which the kubelet fills in once the pull completes.
//
// Three states a row can be in:
//   1. Sentinel — image known, digest still NULL while the pull is
//      in flight. NULLS NOT DISTINCT on the unique index keeps this
//      a singleton per deployment.
//   2. Resolved — sentinel updated in place once the kubelet reports
//      a digest. From this point the row is immutable.
//   3. New-digest — a fresh row when the same deployment runs a NEW
//      digest later (image tag re-pushed, or admin upgraded the tag).
//
// Gated by `system_settings.custom_deployments_image_pull_audit`. The
// reconciler calls into this module unconditionally; the flag check
// happens here so a single source-of-truth toggles the behaviour.

import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import {
  customDeploymentImageAudit,
  systemSettings,
} from '../../db/schema.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

/** Cache key for the operator toggle. Setting is read once per reconciler
 *  tick, not per deployment, so the SELECT cost is amortised. */
let cachedFlag: { value: boolean; expiresAt: number } | null = null;
const FLAG_CACHE_TTL_MS = 60_000;

/**
 * Reset the toggle cache. Test-only helper — the production path
 * refreshes the cache via the 60-second TTL.
 */
export function _resetAuditFlagCache(): void {
  cachedFlag = null;
}

async function readAuditEnabled(db: Database): Promise<boolean> {
  const now = Date.now();
  if (cachedFlag && cachedFlag.expiresAt > now) return cachedFlag.value;
  const [row] = await db.select({
    enabled: systemSettings.customDeploymentsImagePullAudit,
  }).from(systemSettings).limit(1);
  // No row means the system_settings singleton is missing — preserve
  // the historical default (TRUE) so a fresh install audits by default.
  const value = row?.enabled ?? true;
  cachedFlag = { value, expiresAt: now + FLAG_CACHE_TTL_MS };
  return value;
}

interface PodContainerStatus {
  readonly name: string;
  readonly image: string;
  readonly imageID: string;
}

interface PodList {
  readonly items: readonly { readonly status?: { readonly containerStatuses?: PodContainerStatus[] } }[];
}

/**
 * Inspect every pod backing the named Deployment and upsert audit
 * rows for each unique container image. The DB unique constraint
 * (NULLS NOT DISTINCT on `(deployment_id, resolved_digest)`)
 * de-duplicates concurrent inserts.
 *
 * @returns the number of rows actually inserted or updated.
 */
export async function recordImageAudit(
  db: Database,
  k8s: K8sClients,
  deploymentId: string,
  namespace: string,
  deploymentName: string,
): Promise<number> {
  if (!(await readAuditEnabled(db))) return 0;

  const pods = (await k8s.core.listNamespacedPod({
    namespace,
    labelSelector: `app=${deploymentName}`,
  } as Parameters<typeof k8s.core.listNamespacedPod>[0])) as unknown as PodList;

  // Collect every (image, digest) pair seen across the pod's
  // containers. Init containers are excluded — the busybox depends_on
  // init image is platform-controlled and not worth auditing.
  const observed = new Map<string, { image: string; digest: string | null }>();
  for (const pod of pods.items ?? []) {
    for (const cs of pod.status?.containerStatuses ?? []) {
      const image = cs.image;
      if (!image) continue;
      // `imageID` looks like `docker-pullable://nginx@sha256:<hex>`
      // or `nginx@sha256:<hex>`. Extract just the sha256:<hex> suffix
      // (with the algo prefix preserved).
      const digest = parseImageId(cs.imageID);
      // Key by (image, digest) so a pod running two distinct digests
      // for the same image (unlikely but possible during rollouts)
      // both get recorded.
      const k = `${image}|${digest ?? ''}`;
      observed.set(k, { image, digest });
    }
  }

  if (observed.size === 0) return 0;

  let touched = 0;
  for (const { image, digest } of observed.values()) {
    if (digest === null) {
      // Sentinel insert. Idempotent: a second insert with the same
      // (deployment_id, NULL) is rejected by the NULLS NOT DISTINCT
      // unique constraint and we treat that as a no-op.
      try {
        await db.insert(customDeploymentImageAudit).values({
          id: randomUUID(),
          deploymentId,
          image,
          resolvedDigest: null,
        });
        touched++;
      } catch (err: unknown) {
        if (!isUniqueViolation(err)) throw err;
      }
      continue;
    }

    // Resolved path: try to update the existing sentinel row first
    // (replaces NULL digest in place), and if no row was touched
    // (already had a resolved digest), insert a fresh row.
    const updated = await db
      .update(customDeploymentImageAudit)
      .set({ resolvedDigest: digest, image, pulledAt: new Date() })
      .where(and(
        eq(customDeploymentImageAudit.deploymentId, deploymentId),
        isNull(customDeploymentImageAudit.resolvedDigest),
      ))
      .returning({ id: customDeploymentImageAudit.id });

    if (updated.length > 0) {
      touched++;
      continue;
    }

    try {
      await db.insert(customDeploymentImageAudit).values({
        id: randomUUID(),
        deploymentId,
        image,
        resolvedDigest: digest,
      });
      touched++;
    } catch (err: unknown) {
      // (deployment, digest) already audited — silent dedupe.
      if (!isUniqueViolation(err)) throw err;
    }
  }

  return touched;
}

function parseImageId(imageID: string | undefined): string | null {
  if (!imageID) return null;
  // Strip Kubernetes' `docker-pullable://` / `containerd://` prefixes.
  const cleaned = imageID.replace(/^[a-z0-9.+-]+:\/\//, '');
  const atIdx = cleaned.lastIndexOf('@');
  if (atIdx === -1) return null;
  const digest = cleaned.slice(atIdx + 1);
  // Light shape check — sha256:<hex>.
  if (!/^sha\d+:[0-9a-f]+$/.test(digest)) return null;
  return digest;
}

function isUniqueViolation(err: unknown): boolean {
  // Postgres SQLSTATE 23505 — wrapped by Drizzle in DrizzleQueryError.cause.
  type PgLike = { code?: string; cause?: unknown };
  let cur: PgLike | undefined = err as PgLike;
  for (let i = 0; i < 5 && cur; i++) {
    if (cur.code === '23505') return true;
    cur = cur.cause as PgLike | undefined;
  }
  return false;
}
