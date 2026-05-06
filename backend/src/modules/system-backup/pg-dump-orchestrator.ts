/**
 * pg_dump orchestrator — runs inside the pg-dump-job pod.
 *
 * Pipeline:
 *   1. Resolve target backup_configurations row (S3 / SSH).
 *   2. Resolve CNPG cluster credentials by reading the Cluster CR's
 *      `.spec.bootstrap.initdb.secret.name` and fetching that Secret
 *      from the source namespace (with a `<cluster>-app` fallback).
 *      We do NOT use Pod env secretKeyRef — it's namespace-local and
 *      breaks for cross-namespace clusters like mail/mail-pg.
 *   3. Reserve a BackupStore bundle under synthetic clientId='__system__'
 *      so system artifacts live in a dedicated subtree.
 *   4. Spawn `pg_dump --format=custom --compress=9 --no-owner
 *      --no-privileges` against the CNPG `<cluster>-ro` read-replica
 *      service so the dump doesn't load the primary. PGUSER/PGPASSWORD
 *      are passed via the spawn env (NOT pod env, NOT command-line
 *      args — never visible in `ps`).
 *   5. Pipe stdout through a hash/size accounting transform into the
 *      BackupStore.writeComponent stream. `stream/promises.pipeline`
 *      wires backpressure end-to-end so a slow store can't OOM the
 *      Job pod by buffering an unbounded multi-GB dump.
 *   6. Persist bundleId + artifactName + sha256 + size_bytes on the
 *      system_backup_runs row; status='succeeded'.
 *
 * On any failure: the partial bundle is `delete()`d so we don't leak
 * orphan artifacts, the run row is updated to status='failed', and a
 * scrubbed (no PG creds, no connection URIs) error envelope is stored
 * for the operator UI.
 *
 * Reuses tenant-bundles's BackupStore interface + S3/SshBackupStore — does
 * NOT modify tenant-bundles module code.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { systemBackupRuns, backupConfigurations } from '../../db/schema.js';
import { S3BackupStore } from '../tenant-bundles/s3-backup-store.js';
import { SshBackupStore } from '../tenant-bundles/ssh-backup-store.js';
import type { BackupStore, BundleHandle } from '../tenant-bundles/bundle-store.js';
import { decrypt } from '../oidc/crypto.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

export interface PgDumpInputs {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly runId: string;
  readonly namespace: string;
  readonly cluster: string;
  readonly database: string;
  readonly targetConfigId: string;
  readonly oidcEncryptionKey: string | null;
}

export interface PgDumpResult {
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly bundleId: string;
  readonly artifactName: string;
}

const SYSTEM_CLIENT_ID = '__system__';
const CNPG_GROUP = 'postgresql.cnpg.io';
const CNPG_VERSION = 'v1';
const MAX_STDERR_BYTES = 2000;

interface ResolvedCreds {
  readonly username: string;
  readonly password: string;
}

interface ResolvedStore {
  readonly store: BackupStore;
  readonly targetType: 's3' | 'ssh';
}

/**
 * Read the CNPG Cluster CR + its bootstrap Secret to recover the
 * application user creds. Falls back to `<cluster>-app` (CNPG's
 * default managed Secret) if the CR has no explicit bootstrap.secret.
 *
 * Throws with a scrubbed error if neither path resolves.
 */
export async function resolveCnpgCredentials(
  k8s: K8sClients,
  namespace: string,
  cluster: string,
): Promise<ResolvedCreds> {
  const candidates: string[] = [];

  // Path 1: read .spec.bootstrap.initdb.secret.name from the Cluster CR.
  try {
    const custom = k8s.custom as unknown as {
      getNamespacedCustomObject: (a: {
        group: string; version: string; namespace: string; plural: string; name: string;
      }) => Promise<{ spec?: { bootstrap?: { initdb?: { secret?: { name?: string } } } } }>;
    };
    const cr = await custom.getNamespacedCustomObject({
      group: CNPG_GROUP, version: CNPG_VERSION, namespace, plural: 'clusters', name: cluster,
    });
    const bootstrapSecret = cr?.spec?.bootstrap?.initdb?.secret?.name;
    if (bootstrapSecret) candidates.push(bootstrapSecret);
  } catch {
    // CR missing or RBAC denied — fall through to the default.
  }

  // Path 2: CNPG default managed Secret name.
  candidates.push(`${cluster}-app`);

  const core = k8s.core as unknown as {
    readNamespacedSecret: (a: { namespace: string; name: string })
      => Promise<{ data?: Record<string, string> }>;
  };

  for (const secretName of candidates) {
    try {
      const sec = await core.readNamespacedSecret({ namespace, name: secretName });
      const data = sec.data ?? {};
      const usernameB64 = data.username ?? data.PGUSER;
      const passwordB64 = data.password ?? data.PGPASSWORD;
      if (!usernameB64 || !passwordB64) continue;
      return {
        username: Buffer.from(usernameB64, 'base64').toString('utf8'),
        password: Buffer.from(passwordB64, 'base64').toString('utf8'),
      };
    } catch {
      // try next candidate
    }
  }

  throw new Error(
    `unable to resolve CNPG credentials for cluster ${namespace}/${cluster}: tried ${candidates.join(', ')}`,
  );
}

export const SYSTEM_BACKUP_CLIENT_ID = SYSTEM_CLIENT_ID;

export async function resolveSystemStore(
  db: Database,
  targetConfigId: string,
  oidcEncryptionKey: string | null,
): Promise<ResolvedStore> {
  // Explicit projection — NEVER `SELECT *` on a table that holds
  // encrypted credentials (DB review H3).
  const rows = await db
    .select({
      id: backupConfigurations.id,
      active: backupConfigurations.active,
      storageType: backupConfigurations.storageType,
      s3Endpoint: backupConfigurations.s3Endpoint,
      s3Region: backupConfigurations.s3Region,
      s3Bucket: backupConfigurations.s3Bucket,
      s3Prefix: backupConfigurations.s3Prefix,
      s3AccessKeyEncrypted: backupConfigurations.s3AccessKeyEncrypted,
      s3SecretKeyEncrypted: backupConfigurations.s3SecretKeyEncrypted,
      sshHost: backupConfigurations.sshHost,
      sshPort: backupConfigurations.sshPort,
      sshUser: backupConfigurations.sshUser,
      sshPath: backupConfigurations.sshPath,
      sshKeyEncrypted: backupConfigurations.sshKeyEncrypted,
    })
    .from(backupConfigurations)
    .where(eq(backupConfigurations.id, targetConfigId))
    .limit(1);
  const cfg = rows[0];
  if (!cfg) throw new Error(`backup_configurations row ${targetConfigId} not found`);
  if (cfg.active === false) throw new Error(`backup_configurations row ${targetConfigId} is not active`);

  const decryptIfPresent = (s: string | null | undefined): string => {
    if (!s) return '';
    if (!oidcEncryptionKey) throw new Error('OIDC_ENCRYPTION_KEY required to decrypt backup target credentials');
    return decrypt(s, oidcEncryptionKey);
  };

  if (cfg.storageType === 's3') {
    const store = new S3BackupStore({
      endpoint: cfg.s3Endpoint ?? undefined,
      region: cfg.s3Region ?? 'us-east-1',
      bucket: cfg.s3Bucket ?? '',
      accessKeyId: decryptIfPresent(cfg.s3AccessKeyEncrypted),
      secretAccessKey: decryptIfPresent(cfg.s3SecretKeyEncrypted),
      pathPrefix: `${cfg.s3Prefix ?? ''}/system-backup`.replace(/^\/+/, ''),
    });
    return { store, targetType: 's3' };
  }
  if (cfg.storageType === 'ssh') {
    const store = new SshBackupStore({
      host: cfg.sshHost ?? '',
      port: cfg.sshPort ?? 22,
      user: cfg.sshUser ?? '',
      privateKey: decryptIfPresent(cfg.sshKeyEncrypted),
      basePath: `${cfg.sshPath ?? '/backups'}/system-backup`,
    });
    return { store, targetType: 'ssh' };
  }
  throw new Error(`backup_configurations.storage_type=${cfg.storageType} not supported`);
}

/**
 * Strip credentials and connection URIs from pg_dump stderr before
 * embedding it in an operator-visible error envelope. pg_dump is
 * conservative about logging passwords directly, but a connection
 * string in the error can leak PGUSER. Belt-and-braces.
 */
function scrubStderr(raw: string): string {
  return raw
    // Mask postgres URIs (postgres://user:pass@host/db).
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, 'postgres://[REDACTED]')
    // Mask explicit password=... clauses.
    .replace(/password\s*=\s*\S+/gi, 'password=[REDACTED]')
    // Mask user=… in stderr (avoid leaking app username).
    .replace(/\buser\s*=\s*\S+/gi, 'user=[REDACTED]')
    .slice(0, MAX_STDERR_BYTES);
}

interface SpawnedDump {
  readonly stdout: NodeJS.ReadableStream;
  readonly stderrText: () => string;
  readonly done: Promise<void>;
}

function spawnPgDump(
  namespace: string,
  cluster: string,
  database: string,
  creds: ResolvedCreds,
): SpawnedDump {
  // `-r` routes to ANY ready instance (primary or replica). `-ro`
  // would be cleaner (offload to replicas) but selects replicas
  // only — when a cluster is scaled to 1 instance, `-ro` has zero
  // endpoints and pg_dump gets connection refused. `-r` always has
  // endpoints if any pod is ready.
  const host = `${cluster}-r.${namespace}.svc`;
  const args = [
    '-h', host,
    '-p', '5432',
    '-d', database,
    '--format=custom',
    '--compress=9',
    '--no-owner',
    '--no-privileges',
  ];
  // Pass creds via env (not args). spawn uses execve so env is private
  // to the child process — never appears in /proc/<pid>/cmdline. Inherit
  // PATH from the parent process so `pg_dump` can be found.
  const proc = spawn('pg_dump', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PGUSER: creds.username,
      PGPASSWORD: creds.password,
    },
  });
  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;
  proc.stderr.on('data', (c: Buffer) => {
    if (stderrBytes < MAX_STDERR_BYTES * 2) {
      stderrChunks.push(c);
      stderrBytes += c.length;
    }
  });
  const done = new Promise<void>((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pg_dump exit ${code}`));
    });
  });
  return {
    stdout: proc.stdout,
    stderrText: () => Buffer.concat(stderrChunks).toString('utf8'),
    done,
  };
}

export async function runPgDump(inputs: PgDumpInputs): Promise<PgDumpResult> {
  const { db, k8s, runId, namespace, cluster, database, targetConfigId, oidcEncryptionKey } = inputs;

  await db.update(systemBackupRuns)
    .set({ status: 'running', jobName: process.env.HOSTNAME ?? null })
    .where(eq(systemBackupRuns.id, runId));

  let handle: BundleHandle | null = null;
  let store: BackupStore | null = null;
  let stderrSnapshot = '';
  try {
    const resolved = await resolveSystemStore(db, targetConfigId, oidcEncryptionKey);
    store = resolved.store;
    const creds = await resolveCnpgCredentials(k8s, namespace, cluster);
    handle = await store.reserveBundle({ backupId: runId, clientId: SYSTEM_CLIENT_ID });

    const dump = spawnPgDump(namespace, cluster, database, creds);

    const hasher = createHash('sha256');
    let sizeBytes = 0;
    // Inline hash/size transform so the stream/promises.pipeline below
    // wires backpressure across the whole chain (TS review H1). A
    // manual `data` event handler with `.write()` would not respect
    // the destination's HWM and could OOM the Job on slow upload.
    const hashTransform = new Transform({
      highWaterMark: 8 * 1024 * 1024,
      transform(chunk: Buffer, _enc, cb) {
        hasher.update(chunk);
        sizeBytes += chunk.length;
        cb(null, chunk);
      },
    });

    const artifactName = `${cluster}.${database}.pgdump`;

    // We need to feed the `body: Readable` argument of writeComponent.
    // The hashTransform IS that Readable (after we pipe pg_dump stdout
    // into it). To keep the dump-exit and upload promises distinct,
    // pipe stdout → hashTransform inside a pipeline, then hand the
    // hashTransform to writeComponent which consumes it.
    const stdoutToHash = pipeline(dump.stdout, hashTransform).catch((e: unknown) => {
      throw e instanceof Error ? e : new Error(String(e));
    });
    const writePromise = store.writeComponent(handle, 'config', artifactName, hashTransform, {
      contentType: 'application/octet-stream',
    });

    try {
      await Promise.all([dump.done, stdoutToHash, writePromise]);
    } catch (err) {
      stderrSnapshot = scrubStderr(dump.stderrText());
      const e = err as Error;
      throw new Error(`pg_dump pipeline failed: ${e.message}; stderr: ${stderrSnapshot}`);
    }

    const sha256 = hasher.digest('hex');

    await db.update(systemBackupRuns)
      .set({
        status: 'succeeded',
        finishedAt: new Date(),
        sizeBytes,
        sha256,
        bundleId: handle.bundleId,
        artifactName,
      })
      .where(eq(systemBackupRuns.id, runId));

    return { sizeBytes, sha256, bundleId: handle.bundleId, artifactName };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Cleanup orphan partial bundle (TS review H2). Best-effort —
    // failing here doesn't change the operator-visible state.
    if (handle && store) {
      await store.delete(handle).catch(() => undefined);
    }
    await db.update(systemBackupRuns)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        errorEnvelope: {
          code: 'SYSTEM_BACKUP_PG_DUMP_FAILED',
          message: msg.slice(0, 500),
          stderr: stderrSnapshot || null,
        } as unknown as Record<string, unknown>,
      })
      .where(eq(systemBackupRuns.id, runId));
    throw err;
  }
}
