/**
 * `config` component capture.
 *
 * Per BACKUP_COMPONENT_MODEL.md:
 *   components/config/db-rows.json.gz — gzipped JSON dump of the
 *   client's rows in the platform DB.
 *
 * The dump is a single JSON object with one key per table:
 *
 *   {
 *     "schemaVersion": 1,
 *     "exportedAt": "2026-05-01T10:00:00Z",
 *     "clientId": "...",
 *     "tables": {
 *       "clients":      [ {...} ],
 *       "users":        [ {...}, {...} ],
 *       "domains":      [ {...} ],
 *       …
 *     }
 *   }
 *
 * Tables included are the client's *user-configurable* state — not
 * audit/log/billing tables (those belong to the platform, not the
 * tenant) and not ephemeral runtime state (proxy state, refresh tokens,
 * sftp audit log).
 *
 * Encryption: the config component is **not** encrypted. It contains no
 * secrets (TLS keys live in the `secrets` component). Tenants who want
 * end-to-end encryption can set `exportMode=data_export` which wraps
 * the entire bundle (orchestrator-level concern, not config-level).
 */

import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import type { Database } from '../../../db/index.js';
import * as schema from '../../../db/schema.js';
import type { BackupStore, BundleHandle } from '../bundle-store.js';

const gzipAsync = promisify(gzip);

export const CONFIG_DUMP_SCHEMA_VERSION = 1 as const;

/**
 * Tables included in a client config dump. Order matters for restore —
 * parents (clients, users, domains) before children (deployments,
 * mailboxes, ingressRoutes).
 *
 * Excluded on purpose:
 *   - aiTokenUsage, usageMetrics, subscriptionBillingCycles, refreshTokens,
 *     wafLogs, sftpAuditLog — audit/billing/runtime, owned by the platform.
 *   - storageOperations, storageSnapshots, provisioningTasks — runtime
 *     state, regenerated on restore.
 *   - clientOauth2ProxyState, clientMeshProxyState — runtime proxy state.
 *   - backupJobs, backupComponents, backups, clientBackupSchedules —
 *     metadata about backups, not part of the backed-up state.
 *   - imapSyncJobs — point-in-time job records.
 */
export const CONFIG_DUMP_TABLES = [
  'clients',
  'users',
  'domains',
  'emailDomains',
  'mailboxes',
  'emailAliases',
  'mailSubmitCredentials',
  'sshKeys',
  'sftpUsers',
  'deployments',
  'ingressAuthConfigs',
  'sslCertificates',
  'cronJobs',
  'resourceQuotas',
  'clientOidcProviders',
  'clientMtlsProviders',
  'clientZitiProviders',
  'clientZrokAccounts',
] as const;

type ConfigDumpTable = typeof CONFIG_DUMP_TABLES[number];

interface ConfigDumpV1 {
  schemaVersion: typeof CONFIG_DUMP_SCHEMA_VERSION;
  exportedAt: string;
  clientId: string;
  tables: Record<string, unknown[]>;
}

/**
 * Build the JSON payload for the config component.
 *
 * Pure function — accepts a Drizzle DB handle and a clientId, returns
 * the JSON object that would be gzipped to disk.
 *
 * Visible for testing. Production callers should use
 * {@link captureConfigComponent}.
 */
export async function buildConfigDump(
  db: Database,
  clientId: string,
): Promise<ConfigDumpV1> {
  const tables: Record<string, unknown[]> = {};
  for (const tableName of CONFIG_DUMP_TABLES) {
    const t = (schema as unknown as Record<ConfigDumpTable, unknown>)[tableName];
    if (!t || typeof t !== 'object') continue;
    const rows = await selectClientRows(db, tableName, clientId);
    tables[tableName] = rows;
  }
  return {
    schemaVersion: CONFIG_DUMP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    clientId,
    tables,
  };
}

/**
 * Per-table SELECT helper. Most tables have `client_id`; users joins
 * via `clients.user_id` (since a client is owned by a user, not the
 * other way round). Mailboxes / aliases join through email_domains.
 *
 * For now we use raw SQL via drizzle's sql template — we don't want to
 * couple to the per-table column shape since the dump is intentionally
 * format-agnostic (restore code re-parses it).
 */
async function selectClientRows(
  db: Database,
  tableName: ConfigDumpTable,
  clientId: string,
): Promise<unknown[]> {
  const rawDb = db as unknown as { execute: (q: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }> };
  switch (tableName) {
    case 'clients': {
      const r = await rawDb.execute(sql`SELECT * FROM clients WHERE id = ${clientId}`);
      return r.rows;
    }
    case 'users': {
      // Owner user (clients.user_id) plus any sub-users linked via clients.id.
      const r = await rawDb.execute(sql`
        SELECT * FROM users WHERE id = (SELECT user_id FROM clients WHERE id = ${clientId})
      `);
      return r.rows;
    }
    case 'emailAliases': {
      const r = await rawDb.execute(sql`
        SELECT ea.* FROM email_aliases ea
        JOIN email_domains ed ON ed.id = ea.email_domain_id
        WHERE ed.client_id = ${clientId}
      `);
      return r.rows;
    }
    case 'mailboxes': {
      const r = await rawDb.execute(sql`
        SELECT mb.* FROM mailboxes mb
        JOIN email_domains ed ON ed.id = mb.email_domain_id
        WHERE ed.client_id = ${clientId}
      `);
      return r.rows;
    }
    case 'mailSubmitCredentials': {
      const r = await rawDb.execute(sql`SELECT * FROM mail_submit_credentials WHERE client_id = ${clientId}`);
      return r.rows;
    }
    case 'ingressAuthConfigs': {
      const r = await rawDb.execute(sql`SELECT * FROM ingress_auth_configs WHERE client_id = ${clientId}`);
      return r.rows;
    }
    case 'sftpUsers': {
      const r = await rawDb.execute(sql`SELECT * FROM sftp_users WHERE client_id = ${clientId}`);
      return r.rows;
    }
    case 'sshKeys': {
      const r = await rawDb.execute(sql`SELECT * FROM ssh_keys WHERE client_id = ${clientId}`);
      return r.rows;
    }
    case 'cronJobs': {
      const r = await rawDb.execute(sql`SELECT * FROM cron_jobs WHERE client_id = ${clientId}`);
      return r.rows;
    }
    case 'resourceQuotas': {
      const r = await rawDb.execute(sql`SELECT * FROM resource_quotas WHERE client_id = ${clientId}`);
      return r.rows;
    }
    case 'sslCertificates': {
      const r = await rawDb.execute(sql`SELECT * FROM ssl_certificates WHERE client_id = ${clientId}`);
      return r.rows;
    }
    case 'deployments': {
      const r = await rawDb.execute(sql`SELECT * FROM deployments WHERE client_id = ${clientId}`);
      return r.rows;
    }
    case 'domains': {
      const r = await rawDb.execute(sql`SELECT * FROM domains WHERE client_id = ${clientId}`);
      return r.rows;
    }
    case 'emailDomains': {
      const r = await rawDb.execute(sql`SELECT * FROM email_domains WHERE client_id = ${clientId}`);
      return r.rows;
    }
    case 'clientOidcProviders': {
      const r = await rawDb.execute(sql`SELECT * FROM client_oidc_providers WHERE client_id = ${clientId}`);
      return r.rows;
    }
    case 'clientMtlsProviders': {
      const r = await rawDb.execute(sql`SELECT * FROM client_mtls_providers WHERE client_id = ${clientId}`);
      return r.rows;
    }
    case 'clientZitiProviders': {
      const r = await rawDb.execute(sql`SELECT * FROM client_ziti_providers WHERE client_id = ${clientId}`);
      return r.rows;
    }
    case 'clientZrokAccounts': {
      const r = await rawDb.execute(sql`SELECT * FROM client_zrok_accounts WHERE client_id = ${clientId}`);
      return r.rows;
    }
  }
  // Unreachable for known tables.
  return [];
}

export interface ConfigComponentResult {
  readonly sizeBytes: number;
  readonly rowCount: number;
}

/**
 * Capture the `config` component.
 *
 * Builds the dump in-process (small, fast — no Job needed) and writes
 * it to the BackupStore via `writeComponent`. Works uniformly for
 * hostpath / S3 / SSH backends.
 */
export async function captureConfigComponent(opts: {
  readonly db: Database;
  readonly clientId: string;
  readonly store: BackupStore;
  readonly handle: BundleHandle;
}): Promise<ConfigComponentResult> {
  const dump = await buildConfigDump(opts.db, opts.clientId);
  const totalRows = Object.values(dump.tables).reduce((acc, rows) => acc + rows.length, 0);
  const json = JSON.stringify(dump);
  const gz = await gzipAsync(Buffer.from(json, 'utf8'));
  const stream = Readable.from(gz);
  const ref = await opts.store.writeComponent(opts.handle, 'config', 'db-rows.json.gz', stream, {
    contentType: 'application/gzip',
  });
  return { sizeBytes: ref.sizeBytes, rowCount: totalRows };
}
