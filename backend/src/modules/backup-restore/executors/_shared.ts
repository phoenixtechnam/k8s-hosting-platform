/**
 * Shared helpers for cart restore executors that work off the
 * `config` component's `db-rows.json.gz` dump:
 *
 *   - config-tables       (whole-table apply, allow-listed)
 *   - deployments-by-id   (row-filtered apply on `deployments`)
 *   - domains-by-id       (row-filtered apply on `domains`)
 *
 * The dump shape is produced by `tenant-bundles/components/config.ts`
 * via SELECT * — column names originate from Drizzle schema defs,
 * not from any external input.
 *
 * Safety rails:
 *   - All identifier interpolation uses `sql.identifier()` which
 *     quotes-and-escapes per Postgres rules.
 *   - All values are bound parameters via `sql` template literal.
 *   - Table allow-list is enforced by callers.
 *   - Cross-tenant guard (dump.clientId === restoreJob.clientId) is
 *     enforced before any rows are applied.
 */

import type { FastifyInstance } from 'fastify';
import { sql, eq } from 'drizzle-orm';
import { gunzipSync } from 'node:zlib';
import { ApiError } from '../../../shared/errors.js';
import { restoreJobs, type RestoreItem } from '../../../db/schema.js';
import type { BackupStore } from '../../tenant-bundles/bundle-store.js';

export interface ConfigDump {
  schemaVersion: number;
  clientId: string;
  tables: Record<string, Array<Record<string, unknown>>>;
}

/**
 * Read + parse the config dump from a bundle. Throws ApiError on
 * missing artefact / wrong schemaVersion / cross-tenant mismatch.
 */
export async function readAndAuthorizeConfigDump(args: {
  app: FastifyInstance;
  item: RestoreItem;
  store: BackupStore;
}): Promise<ConfigDump> {
  const { app, item, store } = args;
  const handle = await store.open(item.bundleId);
  if (!handle) throw new ApiError('NOT_FOUND', `Bundle ${item.bundleId} not found on remote target`, 404);
  const stream = await store.readComponent(handle, 'config', 'db-rows.json.gz');
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  const buf = gunzipSync(Buffer.concat(chunks));
  const dump = JSON.parse(buf.toString('utf8')) as ConfigDump;
  if (dump.schemaVersion !== 1) {
    throw new Error(`config dump has unknown schemaVersion ${dump.schemaVersion}`);
  }
  // Cross-tenant guard: refuse to apply a bundle that was captured
  // for a different client than the cart's client. Defence-in-depth
  // against a manually-tampered backup_jobs row pointing the cart at
  // a foreign client's bundle.
  const [job] = await app.db.select().from(restoreJobs).where(eq(restoreJobs.id, item.restoreJobId)).limit(1);
  if (!job) throw new ApiError('NOT_FOUND', `Restore job ${item.restoreJobId} not found`, 404);
  if (dump.clientId && dump.clientId !== job.clientId) {
    throw new ApiError(
      'VALIDATION_ERROR',
      `Bundle's clientId (${dump.clientId}) does not match cart's clientId (${job.clientId}); refusing cross-tenant restore`,
      400,
    );
  }
  return dump;
}

/**
 * Generic per-row INSERT … ON CONFLICT (id) DO UPDATE.
 *
 * SAFE:
 *  - Caller pre-validates `sqlTable` against an allow-list before
 *    invoking; not attacker-controlled.
 *  - Column names come from `SELECT *` against the Drizzle schema —
 *    `sql.identifier()` quotes-and-escapes them.
 *  - Values are bound parameters via sql template interpolation.
 */
export async function upsertRow(
  tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
  sqlTable: string,
  row: Record<string, unknown>,
): Promise<void> {
  const keys = Object.keys(row);
  if (keys.length === 0) return;
  if (!keys.includes('id')) {
    throw new Error(`upsertRow: row in '${sqlTable}' has no 'id' column — bundle format mismatch`);
  }
  const tableFragment = sql.identifier(sqlTable);
  const colsFragment = sql.join(keys.map((k) => sql.identifier(k)), sql`, `);
  const valuesFragment = sql.join(keys.map((k) => sql`${row[k]}`), sql`, `);
  const nonIdKeys = keys.filter((k) => k !== 'id');
  if (nonIdKeys.length > 0) {
    const setFragment = sql.join(
      nonIdKeys.map((k) => sql`${sql.identifier(k)} = EXCLUDED.${sql.identifier(k)}`),
      sql`, `,
    );
    await tx.execute(sql`
      INSERT INTO ${tableFragment} (${colsFragment})
      VALUES (${valuesFragment})
      ON CONFLICT (${sql.identifier('id')}) DO UPDATE SET ${setFragment}
    `);
  } else {
    await tx.execute(sql`
      INSERT INTO ${tableFragment} (${colsFragment})
      VALUES (${valuesFragment})
      ON CONFLICT (${sql.identifier('id')}) DO NOTHING
    `);
  }
}

/**
 * Apply a single ID-filtered restore: read dump, find rows where
 * row.id ∈ selector.ids (or all rows if selector.kind==='all'), and
 * UPSERT each one in a single transaction. Updates the restore_items
 * progress message and size_bytes.
 *
 * `cartItemTable` is the camelCase table name as it appears in the
 * dump (e.g. 'deployments', 'domains'). `sqlTable` is its snake_case
 * physical name. Caller ensures `sqlTable` is in an allow-list.
 */
export async function applyIdFilteredUpsert(args: {
  app: FastifyInstance;
  item: RestoreItem;
  dump: ConfigDump;
  cartItemTable: string;
  sqlTable: string;
  ids: 'all' | readonly string[];
  bundleSizeBytes: number;
}): Promise<void> {
  const { app, item, dump, cartItemTable, sqlTable, ids, bundleSizeBytes } = args;
  const allRows = (dump.tables[cartItemTable] ?? []) as Array<Record<string, unknown>>;
  if (!Array.isArray(allRows)) {
    throw new Error(`config dump has no '${cartItemTable}' table — bundle missing this component?`);
  }
  let pickedRows: Array<Record<string, unknown>>;
  if (ids === 'all') {
    pickedRows = allRows;
  } else {
    const wanted = new Set(ids);
    pickedRows = allRows.filter((r) => typeof r.id === 'string' && wanted.has(r.id as string));
    if (pickedRows.length !== wanted.size) {
      const found = new Set(pickedRows.map((r) => r.id as string));
      const missing = [...wanted].filter((id) => !found.has(id));
      throw new ApiError(
        'NOT_FOUND',
        `${cartItemTable}: ${missing.length} requested id(s) not present in bundle: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`,
        404,
      );
    }
  }

  await app.db.transaction(async (tx) => {
    for (const row of pickedRows) {
      await upsertRow(tx, sqlTable, row);
    }
  });

  await app.db.execute(sql`
    UPDATE restore_items
    SET progress_message = ${`upserted ${pickedRows.length} ${cartItemTable} row(s)`},
        size_bytes = ${bundleSizeBytes}
    WHERE id = ${item.id}
  `);
}
