/**
 * Cluster-trusted-proxies — DB CRUD layer.
 *
 * Pure DB access; no k8s side effects. The reconciler reads from these
 * helpers and materialises the ConfigMap + Traefik DS patch.
 *
 * Three sources tracked (see migration 0020 + cluster-trusted-proxies
 * api-contract for semantics):
 *   - `system`    — synthetic rows surfaced by listAllRanges() but NOT
 *                   stored in DB; they're already baked into the
 *                   static nginx template. UI shows for visibility.
 *   - `bootstrap` — auto-seeded by reconciler from platform_settings
 *                   (k3s pod/svc CIDR detected at bootstrap).
 *                   Idempotent INSERT ON CONFLICT — UI delete forbidden.
 *   - `operator`  — added via admin UI. Full CRUD allowed.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import {
  clusterTrustedProxyRanges,
  type ClusterTrustedProxyRange,
} from '../../db/schema.js';

/** Hardcoded system rows — surfaced for UI visibility, never inserted. */
export const SYSTEM_TRUSTED_PROXIES: ReadonlyArray<{
  readonly cidr: string;
  readonly description: string;
}> = [
  { cidr: '10.0.0.0/8', description: 'RFC1918 / k3s default pod+svc CIDR' },
  { cidr: '172.16.0.0/12', description: 'RFC1918 (docker bridge, dind)' },
  { cidr: '192.168.0.0/16', description: 'RFC1918 (home/private LAN)' },
  { cidr: 'fd00::/8', description: 'IPv6 ULA range' },
];

export interface CreateRangeInput {
  readonly cidr: string;
  readonly description: string;
  readonly source: 'bootstrap' | 'operator';
  readonly createdBy: string | null;
}

/** Insert a range. Throws DUPLICATE_CIDR on conflict. */
export async function createRange(
  db: Database,
  input: CreateRangeInput,
): Promise<ClusterTrustedProxyRange> {
  // Normalise to lowercase for the UNIQUE index (matches lower(cidr) idx).
  const normalised = input.cidr.toLowerCase();
  try {
    const [row] = await db
      .insert(clusterTrustedProxyRanges)
      .values({
        cidr: normalised,
        description: input.description,
        source: input.source,
        createdBy: input.createdBy,
      })
      .returning();
    if (!row) throw new Error('insert returned no row');
    return row;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/duplicate key|unique/i.test(msg)) {
      const e = new Error(`DUPLICATE_CIDR: ${input.cidr} already trusted`);
      (e as Error & { code?: string }).code = 'DUPLICATE_CIDR';
      throw e;
    }
    throw err;
  }
}

/** Idempotent upsert used by the reconciler for bootstrap rows. */
export async function upsertBootstrapRange(
  db: Database,
  cidr: string,
  description: string,
): Promise<void> {
  const normalised = cidr.toLowerCase();
  // ON CONFLICT DO NOTHING preserves the original row (so an operator
  // can't accidentally take over a bootstrap row's audit metadata).
  await db
    .insert(clusterTrustedProxyRanges)
    .values({
      cidr: normalised,
      description,
      source: 'bootstrap',
      createdBy: null,
    })
    .onConflictDoNothing();
}

/** Delete by id — refuses non-operator sources. Throws NOT_DELETABLE. */
export async function deleteRange(db: Database, id: string): Promise<void> {
  const result = await db
    .delete(clusterTrustedProxyRanges)
    .where(
      and(
        eq(clusterTrustedProxyRanges.id, id),
        eq(clusterTrustedProxyRanges.source, 'operator'),
      ),
    )
    .returning({ id: clusterTrustedProxyRanges.id });
  if (result.length === 0) {
    // Either the id doesn't exist, OR it's a non-operator row. Both
    // surface as the same error to avoid leaking row existence.
    const e = new Error(
      `NOT_DELETABLE: row ${id} not found or not deletable (bootstrap/system rows are auto-managed)`,
    );
    (e as Error & { code?: string }).code = 'NOT_DELETABLE';
    throw e;
  }
}

/**
 * List all ranges (DB rows + synthetic system rows). Sorted by source
 * priority (system first, then bootstrap, then operator) and within
 * each group by CIDR for stable display.
 */
export interface ListedRange {
  readonly id: string | null;
  readonly cidr: string;
  readonly description: string;
  readonly source: 'system' | 'bootstrap' | 'operator';
  readonly createdAt: Date | null;
  readonly createdByEmail: string | null;
}

export async function listAllRanges(db: Database): Promise<ListedRange[]> {
  const rows = await db
    .select({
      id: clusterTrustedProxyRanges.id,
      cidr: clusterTrustedProxyRanges.cidr,
      description: clusterTrustedProxyRanges.description,
      source: clusterTrustedProxyRanges.source,
      createdAt: clusterTrustedProxyRanges.createdAt,
      createdByEmail: sql<string | null>`(SELECT email FROM users WHERE id = ${clusterTrustedProxyRanges.createdBy})`,
    })
    .from(clusterTrustedProxyRanges);

  const synthetic: ListedRange[] = SYSTEM_TRUSTED_PROXIES.map((s) => ({
    id: null,
    cidr: s.cidr,
    description: s.description,
    source: 'system' as const,
    createdAt: null,
    createdByEmail: null,
  }));

  const dbRanges: ListedRange[] = rows.map((r) => ({
    id: r.id,
    cidr: r.cidr,
    description: r.description,
    source: (r.source === 'bootstrap' ? 'bootstrap' : 'operator') as
      | 'bootstrap'
      | 'operator',
    createdAt: r.createdAt,
    createdByEmail: r.createdByEmail,
  }));

  const all = [...synthetic, ...dbRanges];
  const sourceOrder: Record<ListedRange['source'], number> = {
    system: 0,
    bootstrap: 1,
    operator: 2,
  };
  all.sort((a, b) => {
    const so = sourceOrder[a.source] - sourceOrder[b.source];
    if (so !== 0) return so;
    return a.cidr.localeCompare(b.cidr);
  });
  return all;
}

/**
 * Returns just the operator + bootstrap CIDRs that need to be
 * MATERIALISED into the ConfigMap and Traefik DS. System rows are
 * skipped because they're already in the static nginx template
 * baseline and Traefik already trusts 127.0.0.1.
 */
export async function listMaterialisedCidrs(db: Database): Promise<string[]> {
  const rows = await db
    .select({ cidr: clusterTrustedProxyRanges.cidr })
    .from(clusterTrustedProxyRanges)
    .orderBy(clusterTrustedProxyRanges.cidr);
  return rows.map((r) => r.cidr);
}
