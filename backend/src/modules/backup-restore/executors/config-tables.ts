/**
 * Restore executor: `config-tables`.
 *
 * Reads `components/config/db-rows.json.gz` from the bundle, picks
 * the requested tables (or all of them), and applies each row via
 * INSERT … ON CONFLICT (id) DO UPDATE. Idempotent.
 *
 * What this executor DOES NOT do (deliberately):
 *   - DELETE rows that exist live but not in the bundle. Explicit
 *     cleanup is the operator's job.
 *   - Cascade through FK chains. Operators who want a multi-table
 *     restore add one cart item per table (or use `kind: 'all'`).
 *
 * Safety:
 *   - All applies are inside one transaction.
 *   - Cross-tenant guard via _shared.readAndAuthorizeConfigDump.
 *   - Identifier-safe via _shared.upsertRow.
 */

import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { BackupStore } from '../../tenant-bundles/bundle-store.js';
import type { RestoreItem } from '../../../db/schema.js';
import { readAndAuthorizeConfigDump, upsertRow } from './_shared.js';

/**
 * Tables this executor is allowed to write to. Must match the set
 * dumped by `tenant-bundles/components/config.ts` (CONFIG_DUMP_TABLES).
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
  const dump = await readAndAuthorizeConfigDump({ app, item, store });

  const allTables = Object.keys(dump.tables);
  let pickedCamel: string[];
  if (selector.kind === 'all') {
    pickedCamel = allTables;
  } else if (selector.kind === 'tables' && Array.isArray(selector.tables)) {
    pickedCamel = selector.tables;
  } else {
    throw new Error(`config-tables: unsupported selector ${JSON.stringify(selector)}`);
  }
  for (const t of pickedCamel) {
    if (!ALLOWED_TABLE_TO_SQL[t]) {
      throw new Error(`config-tables: table '${t}' is not in the restore allow-list`);
    }
    if (!Array.isArray(dump.tables[t])) {
      throw new Error(`config-tables: table '${t}' missing from the bundle dump`);
    }
  }

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

  // Estimate bundle size from the gunzipped JSON we already read.
  // Re-reading would be wasteful; the orchestrator records the
  // authoritative on-disk size separately on the backup_components row.
  const dumpJsonBytes = JSON.stringify(dump).length;
  await app.db.execute(sql`
    UPDATE restore_items
    SET progress_message = ${`upserted ${totalUpserts} rows across ${pickedCamel.length} table(s)`},
        size_bytes = ${dumpJsonBytes}
    WHERE id = ${item.id}
  `);
}
