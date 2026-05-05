/**
 * Restore executor: `config-tables`.
 *
 * Reads `components/config/db-rows.json.gz` from the bundle, picks
 * the requested tables (or all of them), and applies each row via
 * `INSERT ... ON CONFLICT (id) DO UPDATE`. Idempotent: re-running
 * the executor against the same selector yields the same end state.
 *
 * What this executor DOES NOT do (deliberately):
 *   - DELETE rows that exist live but not in the bundle. The
 *     "I restored just one table and it nuked unrelated rows"
 *     surprise is excluded from Phase 4.0; explicit cleanup is the
 *     operator's job.
 *   - Cascade through FK chains. The selector lists tables
 *     explicitly. Operators who want a multi-table restore add one
 *     cart item per table.
 *
 * Safety:
 *   - All applies are inside one transaction. A failure mid-apply
 *     rolls back the whole item.
 *   - INSERT ... ON CONFLICT uses the table's primary key only.
 *     Tables in CONFIG_DUMP_TABLES all use `id` as PK so this is
 *     uniform.
 *   - Column-level merge: the row from the bundle replaces the
 *     live row's values. Any column the live row has but the
 *     bundle row doesn't (e.g. a column added after the bundle was
 *     captured) is preserved by the JSONB-aware UPSERT below.
 */

import type { FastifyInstance } from 'fastify';
import { sql, eq } from 'drizzle-orm';
import { gunzipSync } from 'node:zlib';
import { ApiError } from '../../../shared/errors.js';
import type { BackupStore } from '../../backups-v2/bundle-store.js';
import { restoreJobs, type RestoreItem } from '../../../db/schema.js';

/**
 * Tables this executor is allowed to write to. We only accept
 * tables that are in CONFIG_DUMP_TABLES — matching what the dump
 * produced — and that have an `id` PK + a `client_id` column we
 * can verify owns the row.
 *
 * Tables joined indirectly to client (mailboxes, email_aliases,
 * ingress_auth_configs in some shapes) are still safe because the
 * dump's per-table SELECTs already filter to the client's rows.
 */
const ALLOWED_TABLE_TO_SQL: Record<string, string> = {
  clients: 'clients',
  users: 'users',
  domains: 'domains',
  emailDomains: 'email_domains',
  mailboxes: 'mailboxes',
  emailAliases: 'email_aliases',
  mailSubmitCredentials: 'mail_submit_credentials',
  sshKeys: 'ssh_keys',
  sftpUsers: 'sftp_users',
  deployments: 'deployments',
  ingressAuthConfigs: 'ingress_auth_configs',
  sslCertificates: 'ssl_certificates',
  cronJobs: 'cron_jobs',
  resourceQuotas: 'resource_quotas',
  clientOidcProviders: 'client_oidc_providers',
  clientMtlsProviders: 'client_mtls_providers',
  clientZitiProviders: 'client_ziti_providers',
  clientZrokAccounts: 'client_zrok_accounts',
};

interface Selector {
  kind: 'all' | 'tables';
  tables?: string[];
}

export async function execConfigTablesItem(args: {
  app: FastifyInstance;
  item: RestoreItem;
  store: BackupStore;
}): Promise<void> {
  const { app, item, store } = args;
  const selector = item.selector as unknown as Selector;
  // Read the dump from the bundle.
  const handle = await store.open(item.bundleId);
  if (!handle) throw new ApiError('NOT_FOUND', `Bundle ${item.bundleId} not found on remote target`, 404);
  const stream = await store.readComponent(handle, 'config', 'db-rows.json.gz');
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  const buf = gunzipSync(Buffer.concat(chunks));
  const dump = JSON.parse(buf.toString('utf8')) as {
    schemaVersion: number;
    clientId: string;
    tables: Record<string, Array<Record<string, unknown>>>;
  };
  if (dump.schemaVersion !== 1) {
    throw new Error(`config dump has unknown schemaVersion ${dump.schemaVersion}`);
  }
  // Cross-tenant guard: refuse to apply a bundle that was captured
  // for a different client than the cart's client. Defence-in-depth
  // against a manually-tampered backup_jobs row that re-points
  // bundleId to a foreign client's bundle.
  const [job] = await app.db.select().from(restoreJobs).where(eq(restoreJobs.id, item.restoreJobId)).limit(1);
  if (!job) throw new ApiError('NOT_FOUND', `Restore job ${item.restoreJobId} not found`, 404);
  if (dump.clientId && dump.clientId !== job.clientId) {
    throw new ApiError(
      'VALIDATION_ERROR',
      `Bundle's clientId (${dump.clientId}) does not match cart's clientId (${job.clientId}); refusing cross-tenant restore`,
      400,
    );
  }

  // Pick the table list per the selector.
  const allTables = Object.keys(dump.tables);
  let pickedCamel: string[];
  if (selector.kind === 'all') {
    pickedCamel = allTables;
  } else if (selector.kind === 'tables' && Array.isArray(selector.tables)) {
    pickedCamel = selector.tables;
  } else {
    throw new Error(`config-tables: unsupported selector ${JSON.stringify(selector)}`);
  }
  // Validate every requested table is in the allow-list. Defends
  // against a forged cart item that names an arbitrary table.
  for (const t of pickedCamel) {
    if (!ALLOWED_TABLE_TO_SQL[t]) {
      throw new Error(`config-tables: table '${t}' is not in the restore allow-list`);
    }
    if (!Array.isArray(dump.tables[t])) {
      throw new Error(`config-tables: table '${t}' missing from the bundle dump`);
    }
  }

  // Apply all table rows in one transaction.
  let totalUpserts = 0;
  await app.db.transaction(async (tx) => {
    for (const camelTable of pickedCamel) {
      const sqlTable = ALLOWED_TABLE_TO_SQL[camelTable]!;
      const rows = dump.tables[camelTable] ?? [];
      for (const row of rows) {
        await upsertRow(tx, sqlTable, row);
        totalUpserts++;
      }
    }
  });

  // Update item progress + size for operator visibility.
  await app.db.execute(sql`
    UPDATE restore_items
    SET progress_message = ${`upserted ${totalUpserts} rows across ${pickedCamel.length} table(s)`},
        size_bytes = ${buf.length}
    WHERE id = ${item.id}
  `);
}

/**
 * Generic per-row INSERT … ON CONFLICT (id) DO UPDATE.
 *
 * Builds the SQL dynamically from the row object's keys. SAFE:
 * - The table name is whitelisted by ALLOWED_TABLE_TO_SQL above
 *   before this is called, so it is operator-controlled, not
 *   attacker-controlled.
 * - Column names come from the JSON dump produced by our own
 *   buildConfigDump → SELECT *. They originate from Drizzle schema
 *   defs, not from any external input.
 * - Values are bound parameters; no string interpolation.
 */
async function upsertRow(
  tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
  sqlTable: string,
  row: Record<string, unknown>,
): Promise<void> {
  const keys = Object.keys(row);
  if (keys.length === 0) return;
  if (!keys.includes('id')) {
    // Tables without an id PK are out of scope for this executor.
    throw new Error(`config-tables: row in '${sqlTable}' has no 'id' column — bundle format mismatch`);
  }
  // Build a parameterised drizzle sql template using sql.identifier()
  // for table + column names. sql.identifier() is the documented
  // safe-quoting helper — it escapes embedded quotes correctly so a
  // degenerate column name (forged bundle, future schema-drift
  // accident) can never break out of the SQL identifier context.
  // Values are bound parameters via sql template interpolation.
  const tableFragment = sql.identifier(sqlTable);
  const colsFragment = sql.join(keys.map((k) => sql.identifier(k)), sql`, `);
  const valuesFragment = sql.join(keys.map((k) => sql`${row[k]}`), sql`, `);
  const nonIdKeys = keys.filter((k) => k !== 'id');
  if (nonIdKeys.length > 0) {
    // Each SET fragment: "<col>" = EXCLUDED."<col>". Identifier-safe
    // by reusing sql.identifier on both sides.
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
