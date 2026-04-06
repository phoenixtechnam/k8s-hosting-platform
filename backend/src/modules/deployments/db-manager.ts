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

  // Wait for both the exec status callback AND the streams to finish.
  // The status callback can fire before all data is flushed to stdout/stderr,
  // causing empty results for large outputs (e.g., database exports).
  let statusError: Error | null = null;

  await new Promise<void>((resolve, reject) => {
    let statusDone = false;
    let stdoutDone = false;
    let stderrDone = false;

    const tryResolve = () => {
      if (statusDone && stdoutDone && stderrDone) {
        if (statusError) reject(statusError);
        else resolve();
      }
    };

    stdoutStream.on('finish', () => { stdoutDone = true; tryResolve(); });
    stderrStream.on('finish', () => { stderrDone = true; tryResolve(); });

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
          if (!s || s.status === 'Success' || s.status === undefined) {
            // Success — end the writable streams so 'finish' fires
            stdoutStream.end();
            stderrStream.end();
          } else {
            const msg = (s.message as string) ?? stderr ?? 'Command execution failed in pod';
            console.error(`[db-manager] Exec failed: status=${JSON.stringify(s)}, stderr=${stderr}`);
            statusError = new Error(msg);
            stdoutStream.end();
            stderrStream.end();
          }
          statusDone = true;
          tryResolve();
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

export type Engine = 'mariadb' | 'mysql' | 'postgresql' | 'mongodb';

export interface DbManagerContext {
  readonly kubeconfigPath: string | undefined;
  readonly namespace: string;
  readonly podName: string;
  readonly containerName: string;
  readonly engine: Engine;
  readonly rootPassword: string;
  readonly rootUsername: string;
  readonly k8s?: K8sClients;
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
  if (runtime === 'mongodb') return 'mongodb';
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

// ─── MongoDB ──────────────────────────────────────────────────────────────────

async function mongoExec(
  kubeconfigPath: string | undefined,
  namespace: string,
  podName: string,
  containerName: string,
  rootPassword: string,
  command: string,
  rootUsername = 'root',
): Promise<string> {
  const authArgs = rootPassword
    ? ['-u', rootUsername, '-p', rootPassword, '--authenticationDatabase', 'admin']
    : [];
  const { stdout, stderr } = await execInPod(
    kubeconfigPath, namespace, podName, containerName,
    ['mongosh', '--quiet', ...authArgs, '--eval', command],
  );
  if (stderr && stderr.includes('MongoServerError')) {
    throw new ApiError('DB_EXEC_ERROR', stderr, 500);
  }
  return stdout;
}

async function mongoListDatabases(
  kp: string | undefined, ns: string, pod: string, cn: string, pw: string, user = 'root',
): Promise<readonly DbDatabase[]> {
  const out = await mongoExec(kp, ns, pod, cn, pw,
    'db.adminCommand({listDatabases:1}).databases.filter(d=>!["admin","config","local"].includes(d.name)).map(d=>d.name).join("\\n")',
    user,
  );
  return out.split('\n').filter(Boolean).map((name) => ({ name }));
}

async function mongoCreateDatabase(
  kp: string | undefined, ns: string, pod: string, cn: string, pw: string, dbName: string, user = 'root',
): Promise<void> {
  await mongoExec(kp, ns, pod, cn, pw,
    `db = db.getSiblingDB("${dbName}"); db.createCollection("_init")`,
    user,
  );
}

async function mongoDropDatabase(
  kp: string | undefined, ns: string, pod: string, cn: string, pw: string, dbName: string, user = 'root',
): Promise<void> {
  await mongoExec(kp, ns, pod, cn, pw,
    `db.getSiblingDB("${dbName}").dropDatabase()`,
    user,
  );
}

async function mongoListCollections(
  kp: string | undefined, ns: string, pod: string, cn: string, pw: string, database: string, user = 'root',
): Promise<readonly string[]> {
  const out = await mongoExec(kp, ns, pod, cn, pw,
    `db.getSiblingDB("${database}").getCollectionNames().filter(c=>c!=='_init').join("\\n")`,
    user,
  );
  return out.split('\n').filter(Boolean);
}

async function mongoListUsers(
  kp: string | undefined, ns: string, pod: string, cn: string, pw: string, user = 'root',
): Promise<readonly DbUser[]> {
  const out = await mongoExec(kp, ns, pod, cn, pw,
    'db.getSiblingDB("admin").system.users.find({},{user:1,roles:1}).toArray().map(u => u.user + "\\t" + u.roles.map(r=>r.db||"admin").join(",")).join("\\n")',
    user,
  );
  return out.split('\n').filter(Boolean).map((line) => {
    const [username, dbs] = line.split('\t');
    return { username, host: '*', databases: dbs ? dbs.split(',') : [] };
  });
}

async function mongoCreateUser(
  kp: string | undefined, ns: string, pod: string, cn: string, pw: string,
  username: string, password: string, database?: string, rootUser = 'root',
): Promise<void> {
  const db = database ?? 'admin';
  await mongoExec(kp, ns, pod, cn, pw,
    `db.getSiblingDB("${db}").createUser({user:"${username}",pwd:"${password}",roles:[{role:"readWrite",db:"${db}"}]})`,
    rootUser,
  );
}

async function mongoDropUser(
  kp: string | undefined, ns: string, pod: string, cn: string, pw: string, username: string, rootUser = 'root',
): Promise<void> {
  // Find the user's database first — users may be created on specific databases, not admin
  const dbName = await mongoExec(kp, ns, pod, cn, pw,
    `var u = db.getSiblingDB("admin").system.users.findOne({user:"${username}"}); u ? u.db : "admin"`,
    rootUser,
  );
  const targetDb = dbName.trim() || 'admin';
  await mongoExec(kp, ns, pod, cn, pw,
    `db.getSiblingDB("${targetDb}").dropUser("${username}")`,
    rootUser,
  );
}

async function mongoSetPassword(
  kp: string | undefined, ns: string, pod: string, cn: string, pw: string,
  username: string, newPassword: string, rootUser = 'root',
): Promise<void> {
  // Find the user's database first
  const dbName = await mongoExec(kp, ns, pod, cn, pw,
    `var u = db.getSiblingDB("admin").system.users.findOne({user:"${username}"}); u ? u.db : "admin"`,
    rootUser,
  );
  const targetDb = dbName.trim() || 'admin';
  await mongoExec(kp, ns, pod, cn, pw,
    `db.getSiblingDB("${targetDb}").changeUserPassword("${username}","${newPassword}")`,
    rootUser,
  );
}

async function mongoExecuteQuery(
  ctx: DbManagerContext,
  database: string,
  query: string,
  startTime: number,
): Promise<QueryResult> {
  const out = await mongoExec(
    ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
    ctx.rootPassword,
    `db = db.getSiblingDB("${database}"); EJSON.stringify(${query})`,
    ctx.rootUsername,
  );
  const elapsed = Date.now() - startTime;

  try {
    const parsed = JSON.parse(out);
    if (Array.isArray(parsed)) {
      const columns = parsed.length > 0 ? Object.keys(parsed[0]) : [];
      const rows = parsed.map((doc: Record<string, unknown>) =>
        columns.map((c) => String(doc[c] ?? '')),
      );
      return { columns, rows, rowCount: rows.length, executionTimeMs: elapsed };
    }
  } catch {
    // Not JSON, return as raw text
  }
  return { columns: ['result'], rows: [[out]], rowCount: 1, executionTimeMs: elapsed };
}

/**
 * Describe a MongoDB collection by sampling a document to infer field names.
 * MongoDB is schema-less, so we return fields from the first document found.
 */
async function mongoDescribeCollection(
  ctx: DbManagerContext,
  database: string,
  collection: string,
): Promise<readonly ColumnInfo[]> {
  const out = await mongoExec(
    ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
    ctx.rootPassword,
    `EJSON.stringify(Object.keys(db.getSiblingDB("${database}").getCollection("${collection}").findOne() || {}))`,
    ctx.rootUsername,
  );

  try {
    const fields = JSON.parse(out);
    if (Array.isArray(fields)) {
      return fields.map((name: string) => ({
        name,
        type: 'mixed',
        nullable: true,
        defaultValue: null,
        key: name === '_id' ? 'PRI' : '',
      }));
    }
  } catch {
    // No documents or parse error
  }
  return [];
}

/**
 * Browse a MongoDB collection with pagination.
 */
async function mongoBrowseCollection(
  ctx: DbManagerContext,
  database: string,
  collection: string,
  options: BrowseOptions,
): Promise<QueryResult> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 1000);
  const offset = Math.max(options.offset ?? 0, 0);
  const orderDir = options.orderDir === 'desc' ? -1 : 1;

  let sortExpr = '{}';
  if (options.orderBy) {
    validateTableName(options.orderBy);
    sortExpr = `{"${options.orderBy}":${orderDir}}`;
  }

  const out = await mongoExec(
    ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
    ctx.rootPassword,
    `EJSON.stringify(db.getSiblingDB("${database}").getCollection("${collection}").find().sort(${sortExpr}).skip(${offset}).limit(${limit}).toArray())`,
    ctx.rootUsername,
  );
  const start = Date.now();

  try {
    const parsed = JSON.parse(out);
    if (Array.isArray(parsed)) {
      const columns = parsed.length > 0 ? Object.keys(parsed[0]) : [];
      const rows = parsed.map((doc: Record<string, unknown>) =>
        columns.map((c) => {
          const val = doc[c];
          return typeof val === 'object' && val !== null ? JSON.stringify(val) : String(val ?? '');
        }),
      );
      return { columns, rows, rowCount: rows.length, executionTimeMs: Date.now() - start };
    }
  } catch {
    // parse error
  }
  return { columns: ['result'], rows: [[out]], rowCount: 1, executionTimeMs: Date.now() - start };
}

/**
 * Count documents in a MongoDB collection.
 */
async function mongoCountDocuments(
  ctx: DbManagerContext,
  database: string,
  collection: string,
): Promise<number> {
  const out = await mongoExec(
    ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
    ctx.rootPassword,
    `db.getSiblingDB("${database}").getCollection("${collection}").countDocuments()`,
    ctx.rootUsername,
  );
  return parseInt(out.trim(), 10) || 0;
}

/**
 * Export a MongoDB database using mongodump --archive (outputs to stdout).
 */
async function mongoExportDatabase(ctx: DbManagerContext, database: string): Promise<string> {
  const authArgs = ctx.rootPassword
    ? ['-u', ctx.rootUsername, '-p', ctx.rootPassword, '--authenticationDatabase', 'admin']
    : [];
  try {
    const { stdout, stderr } = await execInPod(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      ['mongodump', '--db', database, ...authArgs, '--archive=/dev/stdout', '--gzip'],
    );
    if (stderr && stderr.includes('error')) {
      throw new ApiError('DB_EXPORT_ERROR', stderr, 500);
    }
    return stdout;
  } catch (err) {
    if (isBinaryNotFoundError(err)) {
      throw new ApiError(
        'EXPORT_NOT_AVAILABLE',
        'mongodump is not available in this MongoDB container. Use mongosh to export individual collections.',
        400,
      );
    }
    throw err;
  }
}

/**
 * Import into a MongoDB database using mongorestore from stdin.
 */
async function mongoImportDatabase(
  ctx: DbManagerContext,
  database: string,
  data: string,
): Promise<ImportResult> {
  const authArgs = ctx.rootPassword
    ? ['-u', ctx.rootUsername, '-p', ctx.rootPassword, '--authenticationDatabase', 'admin']
    : [];
  try {
    const { stderr } = await execInPodWithStdin(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      ['mongorestore', '--db', database, ...authArgs, '--archive=/dev/stdin', '--gzip'],
      data,
    );
    if (stderr && stderr.includes('error')) {
      return { success: false, error: stderr };
    }
    return { success: true };
  } catch (err) {
    if (isBinaryNotFoundError(err)) {
      return {
        success: false,
        error: 'mongorestore is not available in this MongoDB container.',
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
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
  let rootUsername = 'root';
  if (engine === 'mariadb') rootPassword = String(configuration.MARIADB_ROOT_PASSWORD ?? '');
  else if (engine === 'mysql') rootPassword = String(configuration.MYSQL_ROOT_PASSWORD ?? '');
  else if (engine === 'mongodb') {
    rootPassword = String(configuration.MONGO_INITDB_ROOT_PASSWORD ?? '');
    rootUsername = String(configuration.MONGO_INITDB_ROOT_USERNAME ?? 'root');
  }
  // PostgreSQL uses peer/trust auth inside container — no password needed

  return { kubeconfigPath, namespace, podName, containerName, engine, rootPassword, rootUsername, k8s };
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
  if (ctx.engine === 'mongodb') {
    return mongoListDatabases(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, ctx.rootPassword, ctx.rootUsername,
    );
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
  if (ctx.engine === 'mongodb') {
    return mongoCreateDatabase(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, ctx.rootPassword, name, ctx.rootUsername,
    );
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
  if (ctx.engine === 'mongodb') {
    return mongoDropDatabase(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, ctx.rootPassword, name, ctx.rootUsername,
    );
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
  if (ctx.engine === 'mongodb') {
    return mongoListUsers(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, ctx.rootPassword, ctx.rootUsername,
    );
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
  if (ctx.engine === 'mongodb') {
    return mongoCreateUser(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      ctx.rootPassword, username, password, database, ctx.rootUsername,
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
  if (ctx.engine === 'mongodb') {
    return mongoDropUser(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, ctx.rootPassword, username, ctx.rootUsername,
    );
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
  if (ctx.engine === 'mongodb') {
    return mongoSetPassword(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      ctx.rootPassword, username, password, ctx.rootUsername,
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
    if (ctx.engine === 'mongodb') {
      return await mongoExecuteQuery(ctx, database, query, start);
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

  if (ctx.engine === 'mongodb') {
    return mongoListCollections(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      ctx.rootPassword, database, ctx.rootUsername,
    );
  }

  throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} table listing not supported`, 400);
}

// ─── Table/Database Sizes ────────────────────────────────────────────────────

export interface TableWithSize {
  readonly name: string;
  readonly sizeBytes: number;
  readonly rowCount: number;
}

export interface DatabaseWithSize {
  readonly name: string;
  readonly sizeBytes: number;
}

export async function listTablesWithSize(
  ctx: DbManagerContext,
  database: string,
): Promise<readonly TableWithSize[]> {
  validateDatabaseName(database);

  if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
    const out = await mysqlExec(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      ctx.rootPassword,
      `SELECT TABLE_NAME, COALESCE(DATA_LENGTH + INDEX_LENGTH, 0), TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${database}' ORDER BY TABLE_NAME`,
    );
    return out.split('\n').filter(Boolean).map((line) => {
      const [name, size, rows] = line.split('\t');
      return { name, sizeBytes: parseInt(size, 10) || 0, rowCount: parseInt(rows, 10) || 0 };
    });
  }

  if (ctx.engine === 'postgresql') {
    const csvOut = await pgExecCsv(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      database,
      "SELECT tablename, pg_total_relation_size(schemaname || '.' || tablename), COALESCE((SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = tablename), 0) FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    const { rows } = parsePgCsvOutput(csvOut);
    return rows.filter((r) => r[0]).map((r) => ({
      name: r[0],
      sizeBytes: parseInt(r[1], 10) || 0,
      rowCount: parseInt(r[2], 10) || 0,
    }));
  }

  // MongoDB: return collection stats
  if (ctx.engine === 'mongodb') {
    const tables = await mongoListCollections(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      ctx.rootPassword, database, ctx.rootUsername,
    );
    return tables.map((name) => ({ name, sizeBytes: 0, rowCount: 0 }));
  }

  throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} table size not supported`, 400);
}

export async function listDatabasesWithSize(
  ctx: DbManagerContext,
): Promise<readonly DatabaseWithSize[]> {
  if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
    const systemDbs = new Set(['information_schema', 'performance_schema', 'mysql', 'sys', '']);
    const out = await mysqlExec(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      ctx.rootPassword,
      "SELECT TABLE_SCHEMA, SUM(DATA_LENGTH + INDEX_LENGTH) FROM information_schema.TABLES GROUP BY TABLE_SCHEMA",
    );
    return out.split('\n').filter(Boolean)
      .map((line) => { const [name, size] = line.split('\t'); return { name, sizeBytes: parseInt(size, 10) || 0 }; })
      .filter((d) => !systemDbs.has(d.name));
  }

  if (ctx.engine === 'postgresql') {
    const systemDbs = new Set(['template0', 'template1', 'postgres', '']);
    const csvOut = await pgExecCsv(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      'postgres',
      "SELECT datname, pg_database_size(datname) FROM pg_database WHERE datistemplate = false",
    );
    const { rows } = parsePgCsvOutput(csvOut);
    return rows.filter((r) => r[0] && !systemDbs.has(r[0])).map((r) => ({
      name: r[0],
      sizeBytes: parseInt(r[1], 10) || 0,
    }));
  }

  // Fallback: return databases without sizes
  const dbs = await listDatabases(ctx);
  return dbs.map((d) => ({ ...d, sizeBytes: 0 }));
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
  if (ctx.engine === 'mongodb') {
    return mongoDescribeCollection(ctx, database, table);
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

  if (ctx.engine === 'mongodb') {
    return mongoBrowseCollection(ctx, database, table, { limit, offset, orderBy: options.orderBy, orderDir: options.orderDir });
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

  if (ctx.engine === 'mongodb') {
    return mongoCountDocuments(ctx, database, table);
  }

  throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} row counting not supported`, 400);
}

// ──��� Apply New Credentials to Running Database ─────────────────────────────


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
  if (ctx.engine === 'mongodb') {
    return mongoExportDatabase(ctx, database);
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
    if (ctx.engine === 'mongodb') {
      return await mongoImportDatabase(ctx, database, sql);
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
const VALID_IMPORT_EXTENSIONS = ['.sql', '.sql.gz', '.gz', '.tar', '.tar.gz', '.tgz', '.zip', '.dump', '.backup'];

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
  if (!VALID_IMPORT_EXTENSIONS.some(ext => lower.endsWith(ext))) {
    throw new ApiError(
      'INVALID_FILE_TYPE',
      `Only ${VALID_IMPORT_EXTENSIONS.join(', ')} files are supported for import`,
      400,
      { filePath },
    );
  }
}

/**
 * Extract the full extension from a file path (e.g. ".sql.gz" from "dump.sql.gz").
 */
function getImportFileExtension(filePath: string): string {
  const lower = filePath.toLowerCase();
  // Check compound extensions first
  if (lower.endsWith('.sql.gz')) return '.sql.gz';
  if (lower.endsWith('.tar.gz')) return '.tar.gz';
  const lastDot = lower.lastIndexOf('.');
  return lastDot >= 0 ? lower.slice(lastDot) : '';
}

/**
 * Build the shell command to import a database dump file based on file extension and engine.
 *
 * @param engine - Database engine type
 * @param importPath - Absolute path to the import file inside the database pod
 * @param database - Target database name
 * @param rootPassword - Root password for database auth
 * @param useMysqlBinary - When true, use 'mysql' instead of 'mariadb' CLI binary
 */

/**
 * Import SQL from a file already on the shared PVC (uploaded via the file manager).
 * The route handler reads the file content from the file-manager pod and passes it here.
 * This bypasses the MAX_IMPORT_LENGTH check since the data is read server-side.
 */
/**
 * Import SQL from a file on the shared PVC.
 *
 * Architecture: Database pods mount the PVC with a subPath (e.g. databases/maria-52c5ef),
 * so they only see their own directory as their data root (e.g. /var/lib/mysql).
 * The file-manager pod mounts the full PVC at /data.
 *
 * Strategy: The backend copies the source file into the database's subPath directory
 * via the file-manager, then the database pod reads it from its own mount.
 */
export async function importSqlFromPvcFile(
  ctx: DbManagerContext,
  database: string,
  _sqlContent: string,
  filePath: string,
  deploymentSubPath: string,
): Promise<ImportResult> {
  validateDatabaseName(database);
  validatePvcFilePath(filePath);

  // The file to import is at /data/<filePath> in the file-manager pod.
  // The database pod only sees /data/<deploymentSubPath>/ as its data root.
  // We need to reference the file relative to the database pod's mount.

  // Determine the database pod's data root path (engine-specific)
  const dataRoot = (ctx.engine === 'mariadb' || ctx.engine === 'mysql')
    ? '/var/lib/mysql'
    : (ctx.engine === 'postgresql' ? '/var/lib/postgresql/data' : '/data/db');

  // The import file path inside the database pod:
  // File-manager path: /data/<filePath>
  // Database subPath: databases/<name>-<suffix>
  // If the file is inside the database's subPath, we can reference it directly.
  // Otherwise, we use a temp import path.
  const cleanFilePath = filePath.replace(/^\/+/, '');
  const cleanSubPath = deploymentSubPath.replace(/^\/+/, '').replace(/\/+$/, '');
  const fileExt = getImportFileExtension(filePath);
  const importFileName = `_import_${Date.now()}${fileExt}`;
  const sqlFileName = `_import_${Date.now()}.sql`;

  try {
    // Copy the source file to the database's subPath using file-manager exec
    // Both paths are visible to the file-manager pod at /data/
    const fmPods = await ctx.k8s!.core.listNamespacedPod({
      namespace: ctx.namespace,
      labelSelector: 'app=file-manager',
    });
    const fmPodItems = (fmPods as { items?: readonly { metadata?: { name?: string }; status?: { phase?: string } }[] }).items ?? [];
    const fmPod = fmPodItems.find(p => p.status?.phase === 'Running');

    if (!fmPod?.metadata?.name) {
      throw new Error('File manager pod not found or not running');
    }

    // Step 1: Extract/decompress archives in the file-manager pod (has tar, unzip, gunzip).
    // Database pods (especially MySQL 8) lack these tools.
    // Result: a plain .sql (or pg_restore-compatible) file in the database's subPath.
    const fmPodName = fmPod.metadata.name;
    const fmSrcPath = `/data/${cleanFilePath}`;
    const fmDestDir = `/data/${cleanSubPath}`;
    const fmSqlPath = `${fmDestDir}/${sqlFileName}`;
    const ext = getImportFileExtension(filePath);

    // For pg_restore formats, keep the original extension
    const isPgRestore = ctx.engine === 'postgresql' && ['.tar', '.dump', '.backup'].includes(ext);
    const dbImportFileName = isPgRestore ? importFileName : sqlFileName;

    if (isPgRestore) {
      // PostgreSQL native format — copy as-is for pg_restore
      await execInPod(ctx.kubeconfigPath, ctx.namespace, fmPodName, 'file-manager',
        ['cp', fmSrcPath, `${fmDestDir}/${importFileName}`]);
    } else if (ext === '.sql') {
      await execInPod(ctx.kubeconfigPath, ctx.namespace, fmPodName, 'file-manager',
        ['cp', fmSrcPath, fmSqlPath]);
    } else if (ext === '.sql.gz' || ext === '.gz') {
      await execInPod(ctx.kubeconfigPath, ctx.namespace, fmPodName, 'file-manager',
        ['sh', '-c', `gunzip -c '${fmSrcPath}' > '${fmSqlPath}'`]);
    } else if (ext === '.tar.gz' || ext === '.tgz') {
      await execInPod(ctx.kubeconfigPath, ctx.namespace, fmPodName, 'file-manager',
        ['sh', '-c', `set -e; rm -rf /tmp/_imp; mkdir -p /tmp/_imp; tar xzf '${fmSrcPath}' -C /tmp/_imp; find /tmp/_imp -name '*.sql' -type f -exec cat {} + > '${fmSqlPath}'; rm -rf /tmp/_imp`]);
    } else if (ext === '.tar') {
      await execInPod(ctx.kubeconfigPath, ctx.namespace, fmPodName, 'file-manager',
        ['sh', '-c', `set -e; rm -rf /tmp/_imp; mkdir -p /tmp/_imp; tar xf '${fmSrcPath}' -C /tmp/_imp; find /tmp/_imp -name '*.sql' -type f -exec cat {} + > '${fmSqlPath}'; rm -rf /tmp/_imp`]);
    } else if (ext === '.zip') {
      await execInPod(ctx.kubeconfigPath, ctx.namespace, fmPodName, 'file-manager',
        ['sh', '-c', `set -e; rm -rf /tmp/_imp; mkdir -p /tmp/_imp; unzip -o '${fmSrcPath}' -d /tmp/_imp; find /tmp/_imp -name '*.sql' -type f -exec cat {} + > '${fmSqlPath}'; rm -rf /tmp/_imp`]);
    } else {
      await execInPod(ctx.kubeconfigPath, ctx.namespace, fmPodName, 'file-manager',
        ['cp', fmSrcPath, fmSqlPath]);
    }

    // Verify the extracted file has content (archives may contain no .sql files)
    if (!isPgRestore && ext !== '.sql') {
      const sizeResult = await execInPod(ctx.kubeconfigPath, ctx.namespace, fmPodName, 'file-manager',
        ['sh', '-c', `stat -c '%s' '${fmSqlPath}' 2>/dev/null || echo 0`]);
      const fileSize = parseInt(sizeResult.stdout.trim(), 10) || 0;
      if (fileSize === 0) {
        // Clean up empty file
        await execInPod(ctx.kubeconfigPath, ctx.namespace, fmPodName, 'file-manager',
          ['sh', '-c', `rm -f '${fmSqlPath}'`]).catch(() => {});
        return {
          success: false,
          error: 'No SQL content found in the archive. Ensure the archive contains .sql files.',
        };
      }
    }

    // Step 2: Import from the database pod's mount (only needs the database CLI)
    const importPath = `${dataRoot}/${dbImportFileName}`;
    let result: { stdout: string; stderr: string };

    if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
      // Use the correct CLI binary for the engine — mariadb containers have 'mariadb',
      // MySQL 8+ containers only have 'mysql'. Using sh -c with the wrong binary silently
      // fails because sh itself succeeds even when the inner command is not found.
      const dbCli = ctx.engine === 'mysql' ? 'mysql' : 'mariadb';
      result = await execInPod(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
        ['sh', '-c', `cat '${importPath}' | ${dbCli} -u root -p'${ctx.rootPassword}' '${database}'`]);
      // Clean up import file after import (best-effort)
      await execInPod(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
        ['rm', '-f', importPath]).catch(() => {});
    } else if (ctx.engine === 'postgresql') {
      if (isPgRestore) {
        result = await execInPod(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
          ['sh', '-c', `pg_restore -U postgres -d '${database}' '${importPath}' 2>&1`]);
      } else {
        result = await execInPod(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
          ['sh', '-c', `cat '${importPath}' | psql -U postgres '${database}'`]);
      }
      await execInPod(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
        ['rm', '-f', importPath]).catch(() => {});
    } else {
      throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} file import not supported`, 400);
    }

    if (result.stderr && (result.stderr.includes('ERROR') || result.stderr.includes('error'))) {
      return { success: false, error: result.stderr };
    }

    // Post-import pod health check: wait and verify the pod is still healthy.
    // OOM kills can happen seconds after the import command returns (the DB processes
    // the SQL in the background). We wait 5 seconds to catch delayed crashes.
    if (ctx.k8s) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      try {
        const healthPods = await ctx.k8s.core.listNamespacedPod({
          namespace: ctx.namespace,
          labelSelector: `app=${ctx.podName.replace(/-[a-z0-9]+-[a-z0-9]+$/, '')}`,
        });
        type HealthPod = {
          status?: {
            phase?: string;
            containerStatuses?: readonly {
              state?: { waiting?: { reason?: string } };
              lastState?: { terminated?: { reason?: string } };
            }[];
          };
        };
        const healthPodItems = (healthPods as { items?: readonly HealthPod[] }).items ?? [];
        for (const pod of healthPodItems) {
          for (const cs of pod.status?.containerStatuses ?? []) {
            const waitingReason = cs.state?.waiting?.reason;
            const terminatedReason = cs.lastState?.terminated?.reason;
            const restartCount = (cs as { restartCount?: number }).restartCount ?? 0;
            if (waitingReason === 'CrashLoopBackOff' || terminatedReason === 'OOMKilled' || (terminatedReason && restartCount > 0)) {
              return {
                success: false,
                error: 'Import caused the database to crash (Out of Memory). The database is restarting. Consider splitting the import into smaller files or increasing memory allocation.',
              };
            }
          }
        }
      } catch {
        // Health check failed — not critical, proceed with success
      }
    }

    return { success: true };
  } catch (err) {
    // Clean up temp import file via file-manager pod (best-effort)
    try {
      if (ctx.k8s) {
        const fmPods = await ctx.k8s.core.listNamespacedPod({ namespace: ctx.namespace, labelSelector: 'app=file-manager' });
        const fmPod = ((fmPods as { items?: readonly { metadata?: { name?: string }; status?: { phase?: string } }[] }).items ?? []).find(p => p.status?.phase === 'Running');
        if (fmPod?.metadata?.name) {
          await execInPod(ctx.kubeconfigPath, ctx.namespace, fmPod.metadata.name, 'file-manager',
            ['sh', '-c', `rm -f '/data/${cleanSubPath}/${importFileName}' '/data/${cleanSubPath}/${sqlFileName}'`]);
        }
      }
    } catch { /* cleanup is best-effort */ }

    if (err instanceof ApiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('exit code 137') || message.includes('OOMKilled')) {
      return { success: false, error: 'Import failed: Out of Memory. The database ran out of memory while processing the SQL file. Try splitting the import into smaller files, or increase the deployment memory allocation.' };
    }
    if (message.includes('exit code')) {
      return { success: false, error: `Import failed: ${message}. Check the SQL file for syntax errors.` };
    }
    return { success: false, error: message };
  }
}

/**
 * Export a database dump to a file on the shared PVC.
 * Returns the PVC path where the file was written (relative to /data/).
 */
export async function exportDatabaseToPvc(
  ctx: DbManagerContext,
  database: string,
  outputFileName: string,
  deploymentSubPath: string,
): Promise<{ pvcPath: string; sizeBytes: number }> {
  validateDatabaseName(database);

  const dataRoot = (ctx.engine === 'mariadb' || ctx.engine === 'mysql')
    ? '/var/lib/mysql'
    : (ctx.engine === 'postgresql' ? '/var/lib/postgresql/data' : '/data/db');

  const exportPath = `${dataRoot}/${outputFileName}`;
  const cleanSubPath = deploymentSubPath.replace(/^\/+/, '').replace(/\/+$/, '');

  if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
    const dumpCli = ctx.engine === 'mysql' ? 'mysqldump' : 'mariadb-dump';
    const { stderr } = await execInPod(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      ['sh', '-c', `${dumpCli} -u root -p'${ctx.rootPassword}' --routines --triggers '${database}' > '${exportPath}'`],
    );
    if (stderr && stderr.includes('ERROR')) throw new ApiError('DB_EXPORT_ERROR', stderr, 500);
  } else if (ctx.engine === 'postgresql') {
    const { stderr } = await execInPod(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      ['sh', '-c', `pg_dump -U postgres '${database}' > '${exportPath}'`],
    );
    if (stderr && stderr.includes('ERROR')) throw new ApiError('DB_EXPORT_ERROR', stderr, 500);
  } else {
    throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} PVC export not supported`, 400);
  }

  // Get file size
  const { stdout: sizeOut } = await execInPod(
    ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
    ['stat', '-c', '%s', exportPath],
  );
  const sizeBytes = parseInt(sizeOut.trim(), 10) || 0;

  // Move the export from the database subPath to /data/exports/ via file-manager pod
  const fmPods = await ctx.k8s!.core.listNamespacedPod({
    namespace: ctx.namespace,
    labelSelector: 'app=file-manager',
  });
  const fmPodItems = (fmPods as { items?: readonly { metadata?: { name?: string }; status?: { phase?: string } }[] }).items ?? [];
  const fmPod = fmPodItems.find(p => p.status?.phase === 'Running');

  if (fmPod?.metadata?.name) {
    await execInPod(
      ctx.kubeconfigPath, ctx.namespace, fmPod.metadata.name, 'file-manager',
      ['sh', '-c', `mkdir -p /data/exports && mv '/data/${cleanSubPath}/${outputFileName}' '/data/exports/${outputFileName}'`],
    );
  }

  const pvcPath = `/exports/${outputFileName}`;
  return { pvcPath, sizeBytes };
}
