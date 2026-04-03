/**
 * Database management via K8s pod exec.
 *
 * Executes SQL commands inside running database pods (MariaDB, MySQL, PostgreSQL)
 * to manage databases and users on deployed instances.
 *
 * Also provides generic query execution, table browsing, structure inspection,
 * and import/export for database manager UI.
 */

import { Exec, KubeConfig } from '@kubernetes/client-node';
import { Readable, Writable } from 'node:stream';
import { ApiError } from '../../shared/errors.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

// ─── Binary Not Found Detection ────────────────────────────────────────────

/**
 * Check whether an exec error indicates that the binary was not found in the
 * container.  K8s exec returns various messages depending on the runtime
 * (containerd, CRI-O, Docker) so we match broadly.
 */
function isBinaryNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return (
    lower.includes('executable not found') ||
    lower.includes('not found') ||
    lower.includes('no such file') ||
    lower.includes('command not found') ||
    lower.includes('oci runtime exec failed')
  );
}

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
          const s = status as Record<string, unknown>;
          // K8s exec returns status.status === 'Success' on success
          // Some versions return empty/null status on success too
          if (!s || s.status === 'Success' || s.status === undefined) {
            resolve();
          } else {
            const msg = (s.message as string) ?? stderr ?? 'Command execution failed in pod';
            console.error(`[db-manager] Exec failed: status=${JSON.stringify(s)}, stderr=${stderr}`);
            reject(new Error(msg));
          }
        },
      )
      .catch(reject);
  });

  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function execInPodWithStdin(
  kubeconfigPath: string | undefined,
  namespace: string,
  podName: string,
  containerName: string,
  command: string[],
  stdinData: string,
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

  const stdinStream = new Readable({
    read() {
      this.push(Buffer.from(stdinData));
      this.push(null);
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
        stdinStream,
        false,
        (status) => {
          const s = status as Record<string, unknown>;
          if (!s || s.status === 'Success' || s.status === undefined) {
            resolve();
          } else {
            const msg = (s.message as string) ?? stderr ?? 'Command execution failed in pod';
            console.error(`[db-manager] Exec with stdin failed: status=${JSON.stringify(s)}, stderr=${stderr}`);
            reject(new Error(msg));
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

// ─── Query Execution Types ──────────────────────────────────────────────────

export interface QueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly rowCount: number;
  readonly executionTimeMs: number;
  readonly error?: string;
}

export interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly defaultValue: string | null;
  readonly key: string; // PRI, UNI, MUL, or empty
}

export interface ImportResult {
  readonly success: boolean;
  readonly error?: string;
}

/** Max query length in bytes (1 MB). */
const MAX_QUERY_LENGTH = 1_048_576;

/** Max SQL import payload in bytes (50 MB — matches Fastify body limit). */
const MAX_IMPORT_LENGTH = 52_428_800;

/** Query execution timeout in seconds. */
const QUERY_TIMEOUT_SECONDS = 30;

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
  // Try 'mariadb' first, fall back to 'mysql' only when the binary is missing.
  let result: { stdout: string; stderr: string };
  try {
    result = await execInPod(
      kubeconfigPath, namespace, podName, containerName,
      ['mariadb', '-u', 'root', `-p${rootPassword}`, '-e', sql, '--batch', '--skip-column-names'],
    );
  } catch (err) {
    if (!isBinaryNotFoundError(err)) throw err;
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

// ─── MariaDB/MySQL Query Execution ──────────────────────────────────────────

/**
 * Execute a query with --batch (tab-separated, with header row) for result parsing.
 * Unlike mysqlExec which uses --skip-column-names, this preserves column headers.
 */
async function mysqlExecWithHeaders(
  kubeconfigPath: string | undefined,
  namespace: string,
  podName: string,
  containerName: string,
  rootPassword: string,
  sql: string,
): Promise<string> {
  let result: { stdout: string; stderr: string };
  try {
    result = await execInPod(
      kubeconfigPath, namespace, podName, containerName,
      ['mariadb', '-u', 'root', `-p${rootPassword}`, '-e', sql, '--batch'],
    );
  } catch (err) {
    if (!isBinaryNotFoundError(err)) throw err;
    result = await execInPod(
      kubeconfigPath, namespace, podName, containerName,
      ['mysql', '-u', 'root', `-p${rootPassword}`, '-e', sql, '--batch'],
    );
  }
  const { stdout, stderr } = result;
  if (stderr && stderr.includes('ERROR')) {
    throw new ApiError('DB_EXEC_ERROR', stderr, 500);
  }
  return stdout;
}

/**
 * Parse MySQL --batch output (tab-separated with header row) into columns and rows.
 */
function parseMysqlBatchOutput(output: string): { columns: string[]; rows: string[][] } {
  const lines = output.split('\n').filter(Boolean);
  if (lines.length === 0) return { columns: [], rows: [] };

  const columns = lines[0].split('\t');
  const rows = lines.slice(1).map((line) => line.split('\t'));
  return { columns, rows };
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

// ─── PostgreSQL Query Execution ─────────────────────────────────────────────

/**
 * Execute a PostgreSQL query with --csv output for result parsing.
 */
async function pgExecCsv(
  kubeconfigPath: string | undefined,
  namespace: string,
  podName: string,
  containerName: string,
  database: string,
  sql: string,
): Promise<string> {
  const { stdout, stderr } = await execInPod(
    kubeconfigPath,
    namespace,
    podName,
    containerName,
    ['psql', '-U', 'postgres', '-d', database, '-c', sql, '--csv'],
  );
  if (stderr && stderr.includes('ERROR')) {
    throw new ApiError('DB_EXEC_ERROR', stderr, 500);
  }
  return stdout;
}

/**
 * Parse PostgreSQL --csv output (CSV with header row) into columns and rows.
 * Handles quoted fields containing commas and newlines.
 */
function parsePgCsvOutput(output: string): { columns: string[]; rows: string[][] } {
  const rows = parseCsvLines(output);
  if (rows.length === 0) return { columns: [], rows: [] };
  return { columns: rows[0], rows: rows.slice(1) };
}

/**
 * Minimal CSV parser that handles quoted fields.
 */
function parseCsvLines(input: string): string[][] {
  const result: string[][] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        // Check for escaped quote ""
        if (i + 1 < input.length && input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      current.push(field);
      field = '';
    } else if (ch === '\n') {
      current.push(field);
      field = '';
      if (current.some((f) => f !== '')) {
        result.push(current);
      }
      current = [];
    } else if (ch === '\r') {
      // skip carriage return
    } else {
      field += ch;
    }
  }

  // Handle last field/line
  if (field || current.length > 0) {
    current.push(field);
    if (current.some((f) => f !== '')) {
      result.push(current);
    }
  }

  return result;
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

// ─── Query Execution ────────────────────────────────────────────────────────

function validateQueryLength(query: string): void {
  if (Buffer.byteLength(query, 'utf-8') > MAX_QUERY_LENGTH) {
    throw new ApiError(
      'QUERY_TOO_LARGE',
      `Query exceeds maximum length of ${MAX_QUERY_LENGTH} bytes`,
      400,
      { maxBytes: MAX_QUERY_LENGTH },
    );
  }
}

function validateDatabaseName(database: string): void {
  // Relaxed validation: allow hyphens in database names since some tools create them.
  // This is less strict than validateIdentifier which is for CREATE operations.
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(database)) {
    throw new ApiError(
      'INVALID_DATABASE_NAME',
      'Invalid database name',
      400,
      { database },
    );
  }
}

function validateTableName(table: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(table)) {
    throw new ApiError(
      'INVALID_TABLE_NAME',
      'Invalid table name: must start with a letter or underscore, contain only alphanumerics/underscores, and be 1-64 characters',
      400,
      { table },
    );
  }
}

/**
 * Execute an arbitrary SQL query against a database and return structured results.
 */
export async function executeQuery(
  ctx: DbManagerContext,
  database: string,
  query: string,
): Promise<QueryResult> {
  validateDatabaseName(database);
  validateQueryLength(query);

  const start = Date.now();

  try {
    if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
      return await mysqlExecuteQuery(ctx, database, query, start);
    }
    if (ctx.engine === 'postgresql') {
      return await pgExecuteQuery(ctx, database, query, start);
    }
    throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} query execution not supported`, 400);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const elapsed = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      executionTimeMs: elapsed,
      error: message,
    };
  }
}

async function mysqlExecuteQuery(
  ctx: DbManagerContext,
  database: string,
  query: string,
  startTime: number,
): Promise<QueryResult> {
  const sql = `USE \`${database}\`; ${query}`;
  const output = await mysqlExecWithHeaders(
    ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
    ctx.rootPassword, sql,
  );
  const elapsed = Date.now() - startTime;
  const { columns, rows } = parseMysqlBatchOutput(output);

  return {
    columns,
    rows,
    rowCount: rows.length,
    executionTimeMs: elapsed,
  };
}

async function pgExecuteQuery(
  ctx: DbManagerContext,
  database: string,
  query: string,
  startTime: number,
): Promise<QueryResult> {
  const output = await pgExecCsv(
    ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
    database, query,
  );
  const elapsed = Date.now() - startTime;
  const { columns, rows } = parsePgCsvOutput(output);

  return {
    columns,
    rows,
    rowCount: rows.length,
    executionTimeMs: elapsed,
  };
}

// ─── Table Listing ──────────────────────────────────────────────────────────

/**
 * List all tables (or collections) in a given database.
 */
export async function listTables(
  ctx: DbManagerContext,
  database: string,
): Promise<readonly string[]> {
  validateDatabaseName(database);

  if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
    const out = await mysqlExec(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      ctx.rootPassword, `SHOW TABLES FROM \`${database}\``,
    );
    return out.split('\n').filter(Boolean);
  }

  if (ctx.engine === 'postgresql') {
    const csvOut = await pgExecCsv(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      database, "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    const { rows } = parsePgCsvOutput(csvOut);
    return rows.map((r) => r[0]).filter(Boolean);
  }

  throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} table listing not supported`, 400);
}

// ─── Table Structure ────────────────────────────────────────────────────────

/**
 * Describe the structure (columns) of a table.
 */
export async function describeTable(
  ctx: DbManagerContext,
  database: string,
  table: string,
): Promise<readonly ColumnInfo[]> {
  validateDatabaseName(database);
  validateTableName(table);

  if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
    return mysqlDescribeTable(ctx, database, table);
  }
  if (ctx.engine === 'postgresql') {
    return pgDescribeTable(ctx, database, table);
  }
  throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} table description not supported`, 400);
}

async function mysqlDescribeTable(
  ctx: DbManagerContext,
  database: string,
  table: string,
): Promise<readonly ColumnInfo[]> {
  const output = await mysqlExecWithHeaders(
    ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
    ctx.rootPassword, `DESCRIBE \`${database}\`.\`${table}\``,
  );
  const { rows } = parseMysqlBatchOutput(output);

  // DESCRIBE output columns: Field, Type, Null, Key, Default, Extra
  return rows.map((row) => ({
    name: row[0] ?? '',
    type: row[1] ?? '',
    nullable: (row[2] ?? 'NO') === 'YES',
    defaultValue: row[4] === 'NULL' || row[4] === undefined ? null : row[4],
    key: row[3] ?? '',
  }));
}

async function pgDescribeTable(
  ctx: DbManagerContext,
  database: string,
  table: string,
): Promise<readonly ColumnInfo[]> {
  const sql = `SELECT
    c.column_name,
    c.data_type,
    c.is_nullable,
    c.column_default,
    COALESCE(tc.constraint_type, '') AS key_type
  FROM information_schema.columns c
  LEFT JOIN information_schema.key_column_usage kcu
    ON c.table_name = kcu.table_name AND c.column_name = kcu.column_name AND c.table_schema = kcu.table_schema
  LEFT JOIN information_schema.table_constraints tc
    ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
  WHERE c.table_name = '${table}' AND c.table_schema = 'public'
  ORDER BY c.ordinal_position`;

  const output = await pgExecCsv(
    ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
    database, sql,
  );
  const { rows } = parsePgCsvOutput(output);

  // Map PostgreSQL constraint types to MySQL-style key indicators
  const keyMap: Record<string, string> = {
    'PRIMARY KEY': 'PRI',
    'UNIQUE': 'UNI',
    'FOREIGN KEY': 'MUL',
  };

  return rows.map((row) => ({
    name: row[0] ?? '',
    type: row[1] ?? '',
    nullable: (row[2] ?? 'NO') === 'YES',
    defaultValue: row[3] || null,
    key: keyMap[row[4] ?? ''] ?? '',
  }));
}

// ─── Table Data Browsing ────────────────────────────────────────────────────

export interface BrowseOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly orderBy?: string;
  readonly orderDir?: 'asc' | 'desc';
}

/**
 * Browse table data with pagination and ordering.
 */
export async function browseTable(
  ctx: DbManagerContext,
  database: string,
  table: string,
  options: BrowseOptions = {},
): Promise<QueryResult> {
  validateDatabaseName(database);
  validateTableName(table);

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 1000);
  const offset = Math.max(options.offset ?? 0, 0);
  const orderDir = options.orderDir === 'desc' ? 'DESC' : 'ASC';

  // Build ORDER BY clause if specified
  let orderClause = '';
  if (options.orderBy) {
    validateTableName(options.orderBy); // reuse for column name validation
    if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
      orderClause = ` ORDER BY \`${options.orderBy}\` ${orderDir}`;
    } else {
      orderClause = ` ORDER BY "${options.orderBy}" ${orderDir}`;
    }
  }

  if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
    return executeQuery(ctx, database, `SELECT * FROM \`${table}\`${orderClause} LIMIT ${limit} OFFSET ${offset}`);
  }

  if (ctx.engine === 'postgresql') {
    return executeQuery(ctx, database, `SELECT * FROM "${table}"${orderClause} LIMIT ${limit} OFFSET ${offset}`);
  }

  throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} table browsing not supported`, 400);
}

// ─── Row Count ──────────────────────────────────────────────────────────────

/**
 * Get the row count of a table.
 */
export async function countRows(
  ctx: DbManagerContext,
  database: string,
  table: string,
): Promise<number> {
  validateDatabaseName(database);
  validateTableName(table);

  if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
    const out = await mysqlExec(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      ctx.rootPassword, `SELECT COUNT(*) FROM \`${database}\`.\`${table}\``,
    );
    return parseInt(out.trim(), 10) || 0;
  }

  if (ctx.engine === 'postgresql') {
    const out = await pgExecCsv(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      database, `SELECT COUNT(*) FROM "${table}"`,
    );
    const { rows } = parsePgCsvOutput(out);
    return parseInt(rows[0]?.[0] ?? '0', 10) || 0;
  }

  throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} row counting not supported`, 400);
}

// ─── Export Database ────────────────────────────────────────────────────────

/**
 * Export a database as a SQL dump string.
 */
export async function exportDatabase(
  ctx: DbManagerContext,
  database: string,
): Promise<string> {
  validateDatabaseName(database);

  if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
    return mysqlExportDatabase(ctx, database);
  }
  if (ctx.engine === 'postgresql') {
    return pgExportDatabase(ctx, database);
  }
  throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} database export not supported`, 400);
}

async function mysqlExportDatabase(ctx: DbManagerContext, database: string): Promise<string> {
  // Try mariadb-dump first (MariaDB 11+), fall back to mysqldump only when binary is missing
  let result: { stdout: string; stderr: string };
  try {
    result = await execInPod(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      ['mariadb-dump', '-u', 'root', `-p${ctx.rootPassword}`, '--routines', '--triggers', database],
    );
  } catch (err) {
    if (!isBinaryNotFoundError(err)) throw err;
    result = await execInPod(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      ['mysqldump', '-u', 'root', `-p${ctx.rootPassword}`, '--routines', '--triggers', database],
    );
  }
  if (result.stderr && result.stderr.includes('ERROR')) {
    throw new ApiError('DB_EXPORT_ERROR', result.stderr, 500);
  }
  return result.stdout;
}

async function pgExportDatabase(ctx: DbManagerContext, database: string): Promise<string> {
  const { stdout, stderr } = await execInPod(
    ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
    ['pg_dump', '-U', 'postgres', database],
  );
  if (stderr && stderr.includes('ERROR')) {
    throw new ApiError('DB_EXPORT_ERROR', stderr, 500);
  }
  return stdout;
}

// ─── Import SQL ─────────────────────────────────────────────────────────────

/**
 * Import SQL into a database by piping it through stdin to the CLI tool.
 */
export async function importSql(
  ctx: DbManagerContext,
  database: string,
  sql: string,
): Promise<ImportResult> {
  validateDatabaseName(database);

  if (Buffer.byteLength(sql, 'utf-8') > MAX_IMPORT_LENGTH) {
    throw new ApiError(
      'IMPORT_TOO_LARGE',
      `SQL import exceeds maximum size of ${Math.round(MAX_IMPORT_LENGTH / 1_048_576)}MB. Upload the file via File Manager and use "Import from File" instead.`,
      400,
      { maxBytes: MAX_IMPORT_LENGTH },
    );
  }

  try {
    if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
      return await mysqlImportSql(ctx, database, sql);
    }
    if (ctx.engine === 'postgresql') {
      return await pgImportSql(ctx, database, sql);
    }
    throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} SQL import not supported`, 400);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

async function mysqlImportSql(
  ctx: DbManagerContext,
  database: string,
  sql: string,
): Promise<ImportResult> {
  let result: { stdout: string; stderr: string };
  try {
    result = await execInPodWithStdin(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      ['mariadb', '-u', 'root', `-p${ctx.rootPassword}`, database],
      sql,
    );
  } catch (err) {
    if (!isBinaryNotFoundError(err)) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
    result = await execInPodWithStdin(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      ['mysql', '-u', 'root', `-p${ctx.rootPassword}`, database],
      sql,
    );
  }
  if (result.stderr && result.stderr.includes('ERROR')) {
    return { success: false, error: result.stderr };
  }
  return { success: true };
}

async function pgImportSql(
  ctx: DbManagerContext,
  database: string,
  sql: string,
): Promise<ImportResult> {
  const { stderr } = await execInPodWithStdin(
    ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
    ['psql', '-U', 'postgres', '-d', database],
    sql,
  );
  if (stderr && stderr.includes('ERROR')) {
    return { success: false, error: stderr };
  }
  return { success: true };
}

// ─── Import SQL from PVC File ───────────────────────────────────────────────

/**
 * Validate a PVC-relative file path: no traversal, must be a .sql file, no absolute paths.
 */
function validatePvcFilePath(filePath: string): void {
  if (!filePath || filePath.includes('..')) {
    throw new ApiError(
      'INVALID_PATH',
      'File path cannot be empty or contain ".." traversal',
      400,
      { filePath },
    );
  }
  const lower = filePath.toLowerCase();
  if (!lower.endsWith('.sql') && !lower.endsWith('.sql.gz')) {
    throw new ApiError(
      'INVALID_FILE_TYPE',
      'Only .sql files are supported for import',
      400,
      { filePath },
    );
  }
}

/**
 * Import SQL from a file already on the shared PVC (uploaded via the file manager).
 * The route handler reads the file content from the file-manager pod and passes it here.
 * This bypasses the MAX_IMPORT_LENGTH check since the data is read server-side.
 */
export async function importSqlFromPvcFile(
  ctx: DbManagerContext,
  database: string,
  sqlContent: string,
  filePath: string,
): Promise<ImportResult> {
  validateDatabaseName(database);
  validatePvcFilePath(filePath);

  if (!sqlContent || sqlContent.length === 0) {
    return { success: false, error: 'File is empty' };
  }

  try {
    if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
      return await mysqlImportSql(ctx, database, sqlContent);
    }
    if (ctx.engine === 'postgresql') {
      return await pgImportSql(ctx, database, sqlContent);
    }
    throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} SQL import not supported`, 400);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}
