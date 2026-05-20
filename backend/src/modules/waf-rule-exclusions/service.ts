/**
 * F4 — WAF rule exclusion CRUD service.
 *
 * Operator-managed surgical exclusions to suppress CRS false-positives
 * on a per-(rule_id, hostname) basis. Rows are rendered by reconciler.ts
 * into the modsec-crs-exclusions-dynamic ConfigMap and the modsec-crs
 * Deployment is rolled. See renderer.ts for the .conf format.
 *
 * Concurrency: every mutation (create/update/delete) takes a row-level
 * pg advisory lock to serialise with the reconciler's read-and-render
 * pass — operators editing rapidly won't cause the reconciler to render
 * a half-applied state. The reconciler holds the same lock during its
 * SELECT.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  type CreateWafRuleExclusionRequest,
  type UpdateWafRuleExclusionRequest,
  type WafRuleExclusion,
} from '@k8s-hosting/api-contracts';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { wafRuleExclusions } from '../../db/schema.js';

// Loose Db alias — matches `deps.db: NodePgDatabase<any>` used by the
// route module so callers don't need to launder schema types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = NodePgDatabase<any>;

const ADVISORY_LOCK_ID = 0x77616665_78636c75n; // 'wafe_xclu' as bigint
const MAX_ENABLED = 1000; // matches renderer.DYNAMIC_RULE_ID_MAX range

export class WafRuleExclusionError extends Error {
  constructor(
    public readonly code:
      | 'DUPLICATE'
      | 'NOT_FOUND'
      | 'OVER_CAPACITY'
      | 'INVALID_REGEX',
    message: string,
  ) {
    super(message);
    this.name = 'WafRuleExclusionError';
  }
}

const rowToContract = (row: typeof wafRuleExclusions.$inferSelect): WafRuleExclusion => ({
  id: row.id,
  ruleId: row.ruleId,
  hostnameRegex: row.hostnameRegex,
  scope: row.scope as WafRuleExclusion['scope'],
  reason: row.reason,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  disabled: row.disabled,
});

export const listExclusions = async (
  db: Db,
  opts: { includeDisabled?: boolean } = {},
): Promise<WafRuleExclusion[]> => {
  const where = opts.includeDisabled ? undefined : eq(wafRuleExclusions.disabled, false);
  const rows = await db
    .select()
    .from(wafRuleExclusions)
    .where(where)
    .orderBy(asc(wafRuleExclusions.createdAt), asc(wafRuleExclusions.id));
  return rows.map(rowToContract);
};

/**
 * Used by reconciler.ts — same advisory lock as the mutation paths so
 * a render never observes a half-committed mutation. Always returns
 * only enabled rows.
 */
export const listExclusionsForReconciler = async (
  db: Db,
): Promise<WafRuleExclusion[]> => {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_ID})`);
    const rows = await tx
      .select()
      .from(wafRuleExclusions)
      .where(eq(wafRuleExclusions.disabled, false))
      .orderBy(asc(wafRuleExclusions.createdAt), asc(wafRuleExclusions.id));
    return rows.map(rowToContract);
  });
};

export const createExclusion = async (
  db: Db,
  input: CreateWafRuleExclusionRequest,
  createdBy: string,
): Promise<WafRuleExclusion> => {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_ID})`);

    const countRows = await tx
      .select({ enabled: sql<number>`count(*)::int` })
      .from(wafRuleExclusions)
      .where(eq(wafRuleExclusions.disabled, false));
    const enabledCount = Number(countRows[0]?.enabled ?? 0);
    if (enabledCount >= MAX_ENABLED) {
      throw new WafRuleExclusionError(
        'OVER_CAPACITY',
        `cannot create more than ${MAX_ENABLED} enabled exclusions`,
      );
    }

    // Duplicate check — same (rule_id, hostname_regex, scope) enabled row.
    // The partial unique index will also catch this but the explicit
    // check yields a friendlier error code.
    const existing = await tx
      .select({ id: wafRuleExclusions.id })
      .from(wafRuleExclusions)
      .where(
        and(
          eq(wafRuleExclusions.ruleId, input.ruleId),
          eq(wafRuleExclusions.hostnameRegex, input.hostnameRegex),
          eq(wafRuleExclusions.scope, input.scope),
          eq(wafRuleExclusions.disabled, false),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      throw new WafRuleExclusionError(
        'DUPLICATE',
        `an enabled exclusion already exists for rule ${input.ruleId} on ${input.hostnameRegex} (${input.scope})`,
      );
    }

    const id = randomUUID();
    const now = new Date();
    await tx.insert(wafRuleExclusions).values({
      id,
      ruleId: input.ruleId,
      hostnameRegex: input.hostnameRegex,
      scope: input.scope,
      reason: input.reason,
      createdBy,
      createdAt: now,
      updatedAt: now,
      disabled: false,
    });

    const [row] = await tx.select().from(wafRuleExclusions).where(eq(wafRuleExclusions.id, id));
    return rowToContract(row!);
  });
};

export const updateExclusion = async (
  db: Db,
  id: string,
  input: UpdateWafRuleExclusionRequest,
): Promise<WafRuleExclusion> => {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_ID})`);

    const [current] = await tx
      .select()
      .from(wafRuleExclusions)
      .where(eq(wafRuleExclusions.id, id))
      .limit(1);
    if (!current) {
      throw new WafRuleExclusionError('NOT_FOUND', `exclusion ${id} not found`);
    }

    // If toggling disabled=false (re-enabling) check duplicate against
    // currently-enabled rows.
    const next = {
      hostnameRegex: input.hostnameRegex ?? current.hostnameRegex,
      scope: (input.scope ?? current.scope) as WafRuleExclusion['scope'],
      reason: input.reason ?? current.reason,
      disabled: input.disabled ?? current.disabled,
    };

    if (!next.disabled) {
      // Re-enabling a disabled row also counts against MAX_ENABLED — without
      // this gate an operator could PATCH disabled→false in sequence past
      // 1000, breaking the renderer (which throws beyond DYNAMIC_RULE_ID_MAX)
      // and stalling every future reconcile tick.
      if (current.disabled) {
        const countRows = await tx
          .select({ enabled: sql<number>`count(*)::int` })
          .from(wafRuleExclusions)
          .where(eq(wafRuleExclusions.disabled, false));
        const enabledCount = Number(countRows[0]?.enabled ?? 0);
        if (enabledCount >= MAX_ENABLED) {
          throw new WafRuleExclusionError(
            'OVER_CAPACITY',
            `cannot re-enable: already at ${MAX_ENABLED} enabled exclusions`,
          );
        }
      }

      const dupes = await tx
        .select({ id: wafRuleExclusions.id })
        .from(wafRuleExclusions)
        .where(
          and(
            eq(wafRuleExclusions.ruleId, current.ruleId),
            eq(wafRuleExclusions.hostnameRegex, next.hostnameRegex),
            eq(wafRuleExclusions.scope, next.scope),
            eq(wafRuleExclusions.disabled, false),
          ),
        );
      const otherDupe = dupes.find((d) => d.id !== id);
      if (otherDupe) {
        throw new WafRuleExclusionError(
          'DUPLICATE',
          `an enabled exclusion already exists for rule ${current.ruleId} on ${next.hostnameRegex} (${next.scope})`,
        );
      }
    }

    await tx
      .update(wafRuleExclusions)
      .set({
        hostnameRegex: next.hostnameRegex,
        scope: next.scope,
        reason: next.reason,
        disabled: next.disabled,
        updatedAt: new Date(),
      })
      .where(eq(wafRuleExclusions.id, id));

    const [row] = await tx.select().from(wafRuleExclusions).where(eq(wafRuleExclusions.id, id));
    return rowToContract(row!);
  });
};

export const deleteExclusion = async (db: Db, id: string): Promise<void> => {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_ID})`);
    const result = await tx.delete(wafRuleExclusions).where(eq(wafRuleExclusions.id, id));
    if ((result as unknown as { rowCount?: number }).rowCount === 0) {
      throw new WafRuleExclusionError('NOT_FOUND', `exclusion ${id} not found`);
    }
  });
};
