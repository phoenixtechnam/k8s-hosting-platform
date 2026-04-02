/**
 * Database management via K8s pod exec.
 *
 * Executes SQL commands inside running database pods (MariaDB, MySQL, PostgreSQL)
 * to manage databases and users on deployed instances.
 */

import { Exec, KubeConfig } from '@kubernetes/client-node';
import { Writable } from 'node:stream';
import { ApiError } from '../../shared/errors.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

// ─── Validation ───────────────────────────────────────────────────────────────

const NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

function validateIdentifier(value: string, label: string): void {
  if (!NAME_REGEX.test(value)) {
    throw new ApiError(
      'INVALID_IDENTIFIER',
      `Invalid ${label}: must start with a letter or underscore, contain only alphanumerics/underscores, and be 1-64 characters`,
      400,
      { field: label, value },
    );
  }
}

// ─── K8s Pod Exec ─────────────────────────────────────────────────────────────

function loadKubeConfig(kubeconfigPath?: string): KubeConfig {
  const kc = new KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
  else kc.loadFromCluster();
  return kc;
}

async function execInPod(
  kubeconfigPath: string | undefined,
  namespace: string,
  podName: string,
  containerName: string,
  command: string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const kc = loadKubeConfig(kubeconfigPath);
  const exec = new Exec(kc);

  let stdout = '';
  let stderr = '';

  const stdoutStream = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      stdout += chunk.toString();
      cb();
    },
  });
  const stderrStream = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      stderr += chunk.toString();
      cb();
    },
  });

  await new Promise<void>((resolve, reject) => {
    exec
      .exec(
        namespace,
        podName,
        containerName,
        command,
        stdoutStream,
        stderrStream,
        null,
        false,
        (status) => {
          if ((status as Record<string, unknown>)?.status === 'Success') {
            resolve();
          } else {
            reject(new Error(stderr || 'Command execution failed in pod'));
          }
        },
      )
      .catch(reject);
  });

  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

// ─── Find Pod ─────────────────────────────────────────────────────────────────

async function findPodName(
  k8s: K8sClients,
  namespace: string,
  deploymentName: string,
): Promise<string> {
  const pods = await k8s.core.listNamespacedPod({
    namespace,
    labelSelector: `app=${deploymentName}`,
  });
  const podList =
    (pods as { items?: Array<{ metadata?: { name?: string }; status?: { phase?: string } }> })
      .items ?? [];
  const running = podList.find((p) => p.status?.phase === 'Running');
  if (!running?.metadata?.name) {
    throw new ApiError(
      'POD_NOT_FOUND',
      'No running pod found for this deployment',
      503,
      { deployment: deploymentName, namespace },
      'Ensure the database deployment is running before managing databases',
    );
  }
  return running.metadata.name;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DbDatabase {
  readonly name: string;
}

export interface DbUser {
  readonly username: string;
  readonly host: string;
  readonly databases: readonly string[];
}

export type Engine = 'mariadb' | 'mysql' | 'postgresql';

export interface DbManagerContext {
  readonly kubeconfigPath: string | undefined;
  readonly namespace: string;
  readonly podName: string;
  readonly containerName: string;
  readonly engine: Engine;
  readonly rootPassword: string;
}

// ─── Engine Detection ─────────────────────────────────────────────────────────

function detectEngine(catalogEntry: { runtime?: string | null }): Engine {
  const runtime = catalogEntry.runtime?.toLowerCase();
  if (runtime === 'mariadb') return 'mariadb';
  if (runtime === 'mysql') return 'mysql';
  if (runtime === 'postgresql' || runtime === 'postgres') return 'postgresql';
  throw new ApiError(
    'UNSUPPORTED_ENGINE',
    `Database engine '${catalogEntry.runtime ?? 'unknown'}' is not supported for management`,
    400,
    { runtime: catalogEntry.runtime },
  );
}

// ─── MariaDB / MySQL ──────────────────────────────────────────────────────────

async function mysqlExec(
  kubeconfigPath: string | undefined,
  namespace: string,
  podName: string,
  containerName: string,
  rootPassword: string,
  sql: string,
): Promise<string> {
  // MariaDB 11+ uses 'mariadb' binary; older MariaDB and MySQL use 'mysql'
  // Try 'mariadb' first, fall back to 'mysql'
  let result: { stdout: string; stderr: string };
  try {
    result = await execInPod(
      kubeconfigPath, namespace, podName, containerName,
      ['mariadb', '-u', 'root', `-p${rootPassword}`, '-e', sql, '--batch', '--skip-column-names'],
    );
  } catch {
    result = await execInPod(
      kubeconfigPath, namespace, podName, containerName,
      ['mysql', '-u', 'root', `-p${rootPassword}`, '-e', sql, '--batch', '--skip-column-names'],
    );
  }
  const { stdout, stderr } = result;
  if (stderr && stderr.includes('ERROR')) {
    throw new ApiError('DB_EXEC_ERROR', stderr, 500);
  }
  return stdout;
}

async function mysqlListDatabases(
  kp: string | undefined, ns: string, pod: string, cn: string, pw: string,
): Promise<readonly DbDatabase[]> {
  const systemDbs = new Set(['information_schema', 'performance_schema', 'mysql', 'sys', '']);
  const out = await mysqlExec(kp, ns, pod, cn, pw, 'SHOW DATABASES');
  return out
    .split('\n')
    .filter((name) => !systemDbs.has(name))
    .map((name) => ({ name }));
}

async function mysqlCreateDatabase(
  kp: string | undefined, ns: string, pod: string, cn: string, pw: string, dbName: string,
): Promise<void> {
  await mysqlExec(kp, ns, pod, cn, pw, `CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
}

async function mysqlDropDatabase(
  kp: string | undefined, ns: string, pod: string, cn: string, pw: string, dbName: string,
): Promise<void> {
  await mysqlExec(kp, ns, pod, cn, pw, `DROP DATABASE IF EXISTS \`${dbName}\``);
}

async function mysqlListUsers(
  kp: string | undefined, ns: string, pod: string, cn: string, pw: string,
): Promise<readonly DbUser[]> {
  const systemUsers = new Set([
    'root', 'mariadb.sys', 'mysql.sys', 'mysql.infoschema', 'mysql.session', 'healthcheck',
  ]);
  const out = await mysqlExec(
    kp, ns, pod, cn, pw,
    'SELECT User, Host FROM mysql.user',
  );
  const users = out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [username, host] = line.split('\t');
      return { username, host: host ?? '%' };
    })
    .filter((u) => !systemUsers.has(u.username));

  // Query per-user database grants from mysql.db
  const dbGrantsOut = await mysqlExec(
    kp, ns, pod, cn, pw,
    'SELECT User, Db FROM mysql.db',
  );
  const grantsByUser = new Map<string, string[]>();
  for (const line of dbGrantsOut.split('\n').filter(Boolean)) {
    const [user, db] = line.split('\t');
    if (!user || !db) continue;
    const existing = grantsByUser.get(user) ?? [];
    if (!existing.includes(db)) existing.push(db);
    grantsByUser.set(user, existing);
  }

  return users.map((u) => ({
    ...u,
    databases: grantsByUser.get(u.username) ?? [],
  }));
}

async function mysqlCreateUser(
  kp: string | undefined,
  ns: string,
  pod: string,
  cn: string,
  pw: string,
  username: string,
  password: string,
  dbName?: string,
): Promise<void> {
  await mysqlExec(
    kp, ns, pod, cn, pw,
    `CREATE USER IF NOT EXISTS '${username}'@'%' IDENTIFIED BY '${password}'`,
  );
  if (dbName) {
    await mysqlExec(
      kp, ns, pod, cn, pw,
      `GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${username}'@'%'`,
    );
    await mysqlExec(kp, ns, pod, cn, pw, 'FLUSH PRIVILEGES');
  }
}

async function mysqlDropUser(
  kp: string | undefined, ns: string, pod: string, cn: string, pw: string, username: string,
): Promise<void> {
  await mysqlExec(kp, ns, pod, cn, pw, `DROP USER IF EXISTS '${username}'@'%'`);
}

async function mysqlSetPassword(
  kp: string | undefined,
  ns: string,
  pod: string,
  cn: string,
  pw: string,
  username: string,
  newPassword: string,
): Promise<void> {
  await mysqlExec(
    kp, ns, pod, cn, pw,
    `ALTER USER '${username}'@'%' IDENTIFIED BY '${newPassword}'`,
  );
  await mysqlExec(kp, ns, pod, cn, pw, 'FLUSH PRIVILEGES');
}

// ─── PostgreSQL ───────────────────────────────────────────────────────────────

async function pgExec(
  kubeconfigPath: string | undefined,
  namespace: string,
  podName: string,
  containerName: string,
  sql: string,
): Promise<string> {
  // PostgreSQL uses trust/peer auth inside the container
  const { stdout, stderr } = await execInPod(
    kubeconfigPath,
    namespace,
    podName,
    containerName,
    ['psql', '-U', 'postgres', '-t', '-A', '-c', sql],
  );
  if (stderr && stderr.includes('ERROR')) {
    throw new ApiError('DB_EXEC_ERROR', stderr, 500);
  }
  return stdout;
}

async function pgListDatabases(
  kp: string | undefined, ns: string, pod: string, cn: string,
): Promise<readonly DbDatabase[]> {
  const out = await pgExec(
    kp, ns, pod, cn,
    "SELECT datname FROM pg_database WHERE datistemplate = false AND datname NOT IN ('postgres')",
  );
  return out.split('\n').filter(Boolean).map((name) => ({ name }));
}

async function pgCreateDatabase(
  kp: string | undefined, ns: string, pod: string, cn: string, dbName: string,
): Promise<void> {
  const existing = await pgExec(
    kp, ns, pod, cn,
    `SELECT 1 FROM pg_database WHERE datname = '${dbName}'`,
  );
  if (!existing.trim()) {
    await pgExec(kp, ns, pod, cn, `CREATE DATABASE "${dbName}"`);
  }
}

async function pgDropDatabase(
  kp: string | undefined, ns: string, pod: string, cn: string, dbName: string,
): Promise<void> {
  await pgExec(kp, ns, pod, cn, `DROP DATABASE IF EXISTS "${dbName}"`);
}

async function pgListUsers(
  kp: string | undefined, ns: string, pod: string, cn: string,
): Promise<readonly DbUser[]> {
  const out = await pgExec(
    kp, ns, pod, cn,
    "SELECT usename FROM pg_user WHERE usename NOT IN ('postgres')",
  );
  const users = out
    .split('\n')
    .filter(Boolean)
    .map((username) => ({ username, host: '*' }));

  // Query per-user database grants
  const dbGrantsOut = await pgExec(
    kp, ns, pod, cn,
    "SELECT grantee, table_catalog FROM information_schema.role_table_grants WHERE grantee NOT IN ('postgres', 'PUBLIC') GROUP BY grantee, table_catalog",
  );

  // Also check database-level grants via pg_database + has_database_privilege
  const dbListOut = await pgExec(kp, ns, pod, cn, "SELECT datname FROM pg_database WHERE datistemplate = false AND datname != 'postgres'");
  const allDbs = dbListOut.split('\n').filter(Boolean);

  const grantsByUser = new Map<string, string[]>();
  for (const user of users) {
    const userDbs: string[] = [];
    for (const db of allDbs) {
      const hasAccess = await pgExec(
        kp, ns, pod, cn,
        `SELECT has_database_privilege('${user.username}', '${db}', 'CONNECT')`,
      );
      if (hasAccess.trim() === 't') {
        userDbs.push(db);
      }
    }
    if (userDbs.length > 0) {
      grantsByUser.set(user.username, userDbs);
    }
  }

  return users.map((u) => ({
    ...u,
    databases: grantsByUser.get(u.username) ?? [],
  }));
}

async function pgCreateUser(
  kp: string | undefined,
  ns: string,
  pod: string,
  cn: string,
  username: string,
  password: string,
  dbName?: string,
): Promise<void> {
  const existing = await pgExec(
    kp, ns, pod, cn,
    `SELECT 1 FROM pg_roles WHERE rolname = '${username}'`,
  );
  if (!existing.trim()) {
    await pgExec(kp, ns, pod, cn, `CREATE USER "${username}" WITH PASSWORD '${password}'`);
  }
  if (dbName) {
    await pgExec(
      kp, ns, pod, cn,
      `GRANT ALL PRIVILEGES ON DATABASE "${dbName}" TO "${username}"`,
    );
  }
}

async function pgDropUser(
  kp: string | undefined, ns: string, pod: string, cn: string, username: string,
): Promise<void> {
  await pgExec(kp, ns, pod, cn, `DROP USER IF EXISTS "${username}"`);
}

async function pgSetPassword(
  kp: string | undefined,
  ns: string,
  pod: string,
  cn: string,
  username: string,
  newPassword: string,
): Promise<void> {
  await pgExec(kp, ns, pod, cn, `ALTER USER "${username}" WITH PASSWORD '${newPassword}'`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function buildDbContext(
  k8s: K8sClients,
  kubeconfigPath: string | undefined,
  namespace: string,
  deploymentName: string,
  catalogEntry: { runtime?: string | null; code: string },
  configuration: Record<string, unknown>,
): Promise<DbManagerContext> {
  const engine = detectEngine(catalogEntry);
  const podName = await findPodName(k8s, namespace, deploymentName);

  // Container name is the catalog entry code (matches the container name set in k8s-deployer)
  const containerName = catalogEntry.code;

  // Get root password from configuration
  let rootPassword = '';
  if (engine === 'mariadb') rootPassword = String(configuration.MARIADB_ROOT_PASSWORD ?? '');
  else if (engine === 'mysql') rootPassword = String(configuration.MYSQL_ROOT_PASSWORD ?? '');
  // PostgreSQL uses peer/trust auth inside container — no password needed

  return { kubeconfigPath, namespace, podName, containerName, engine, rootPassword };
}

export async function listDatabases(ctx: DbManagerContext): Promise<readonly DbDatabase[]> {
  if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
    return mysqlListDatabases(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, ctx.rootPassword,
    );
  }
  if (ctx.engine === 'postgresql') {
    return pgListDatabases(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName);
  }
  throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} database listing not supported`, 400);
}

export async function createDatabase(ctx: DbManagerContext, name: string): Promise<void> {
  validateIdentifier(name, 'database name');
  if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
    return mysqlCreateDatabase(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, ctx.rootPassword, name,
    );
  }
  if (ctx.engine === 'postgresql') {
    return pgCreateDatabase(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, name);
  }
  throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} database creation not supported`, 400);
}

export async function dropDatabase(ctx: DbManagerContext, name: string): Promise<void> {
  validateIdentifier(name, 'database name');
  if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
    return mysqlDropDatabase(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, ctx.rootPassword, name,
    );
  }
  if (ctx.engine === 'postgresql') {
    return pgDropDatabase(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, name);
  }
  throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} database deletion not supported`, 400);
}

export async function listUsers(ctx: DbManagerContext): Promise<readonly DbUser[]> {
  if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
    return mysqlListUsers(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, ctx.rootPassword,
    );
  }
  if (ctx.engine === 'postgresql') {
    return pgListUsers(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName);
  }
  throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} user listing not supported`, 400);
}

export async function createUser(
  ctx: DbManagerContext,
  username: string,
  password: string,
  database?: string,
): Promise<void> {
  validateIdentifier(username, 'username');
  if (database) validateIdentifier(database, 'database name');
  if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
    return mysqlCreateUser(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      ctx.rootPassword, username, password, database,
    );
  }
  if (ctx.engine === 'postgresql') {
    return pgCreateUser(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      username, password, database,
    );
  }
  throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} user creation not supported`, 400);
}

export async function dropUser(ctx: DbManagerContext, username: string): Promise<void> {
  validateIdentifier(username, 'username');
  if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
    return mysqlDropUser(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, ctx.rootPassword, username,
    );
  }
  if (ctx.engine === 'postgresql') {
    return pgDropUser(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, username);
  }
  throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} user deletion not supported`, 400);
}

export async function setUserPassword(
  ctx: DbManagerContext,
  username: string,
  password: string,
): Promise<void> {
  validateIdentifier(username, 'username');
  if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
    return mysqlSetPassword(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      ctx.rootPassword, username, password,
    );
  }
  if (ctx.engine === 'postgresql') {
    return pgSetPassword(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, username, password,
    );
  }
  throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} password change not supported`, 400);
}
