/**
 * SQLite database management via K8s pod exec.
 *
 * Executes `sqlite3` commands inside the file-manager pod (which has the
 * client's shared PVC mounted at /data/) to query .sqlite/.db/.sqlite3 files.
 *
 * Unlike MariaDB/PostgreSQL, SQLite is not a running database instance --
 * it is a file on disk. The user selects a file path and we exec into the
 * file-manager pod to run queries against it.
 */

import { Exec, KubeConfig } from '@kubernetes/client-node';
import { Readable, Writable } from 'node:stream';
import { ApiError } from '../../shared/errors.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { QueryResult, ColumnInfo, ImportResult } from '../deployments/db-manager.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Max query length in bytes (1 MB). */
const MAX_QUERY_LENGTH = 1_048_576;

/** Max SQL import payload in bytes (5 MB). */
const MAX_IMPORT_LENGTH = 5_242_880;

const FM_CONTAINER = 'file-manager';

// ─── Validation ──────────────────────────────────────────────────────────────

function validateFilePath(filePath: string): void {
  if (!filePath) {
    throw new ApiError('INVALID_PATH', 'File path is required', 400);
  }
  if (filePath.includes('..') || filePath.startsWith('/')) {
    throw new ApiError('INVALID_PATH', 'File path must be relative and cannot contain ".."', 400);
  }
  // Only allow known SQLite extensions
  const lower = filePath.toLowerCase();
  if (!lower.endsWith('.sqlite') && !lower.endsWith('.db') && !lower.endsWith('.sqlite3')) {
    throw new ApiError('INVALID_FILE_TYPE', 'File must have a .sqlite, .db, or .sqlite3 extension', 400);
  }
}

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

// ─── K8s Pod Exec ────────────────────────────────────────────────────────────

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
        FM_CONTAINER,
        command,
        stdoutStream,
        stderrStream,
        null,
        false,
        (status) => {
          const s = status as Record<string, unknown>;
          if (!s || s.status === 'Success' || s.status === undefined) {
            resolve();
          } else {
            const msg = (s.message as string) ?? stderr ?? 'SQLite exec failed in pod';
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
        FM_CONTAINER,
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
            const msg = (s.message as string) ?? stderr ?? 'SQLite import failed in pod';
            reject(new Error(msg));
          }
        },
      )
      .catch(reject);
  });

  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

// ─── Find File-Manager Pod ──────────────────────────────────────────────────

async function findFileManagerPod(k8s: K8sClients, namespace: string): Promise<string> {
  const pods = await k8s.core.listNamespacedPod({
    namespace,
    labelSelector: 'app=file-manager',
  });
  const podList =
    (pods as { items?: Array<{ metadata?: { name?: string }; status?: { phase?: string } }> })
      .items ?? [];
  const running = podList.find((p) => p.status?.phase === 'Running');
  if (!running?.metadata?.name) {
    throw new ApiError(
      'FILE_MANAGER_NOT_RUNNING',
      'File manager pod is not running. Start the file manager first.',
      503,
      { namespace },
      'Start the file manager from the Files page before using SQLite manager.',
    );
  }
  return running.metadata.name;
}

// ─── CSV Parsing ────────────────────────────────────────────────────────────

/**
 * Parse a single CSV line, handling quoted fields with escaped quotes.
 */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

/**
 * Parse multi-line CSV output from sqlite3 -header -csv.
 * Handles fields that contain newlines inside quotes.
 */
function parseCsvOutput(output: string): { readonly columns: string[]; readonly rows: string[][] } {
  if (!output) return { columns: [], rows: [] };

  const allRows: string[][] = [];
  let currentLine = '';
  let inQuotes = false;

  for (let i = 0; i < output.length; i++) {
    const ch = output[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      currentLine += ch;
    } else if (ch === '\n' && !inQuotes) {
      if (currentLine) {
        allRows.push(parseCsvLine(currentLine));
      }
      currentLine = '';
    } else if (ch === '\r') {
      // skip carriage return
    } else {
      currentLine += ch;
    }
  }
  if (currentLine) {
    allRows.push(parseCsvLine(currentLine));
  }

  if (allRows.length === 0) return { columns: [], rows: [] };

  return {
    columns: allRows[0],
    rows: allRows.slice(1),
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Execute an arbitrary SQL query against a SQLite file.
 */
export async function executeQuery(
  k8s: K8sClients,
  kubeconfigPath: string | undefined,
  namespace: string,
  filePath: string,
  sql: string,
): Promise<QueryResult> {
  validateFilePath(filePath);
  validateQueryLength(sql);

  const start = Date.now();
  const podName = await findFileManagerPod(k8s, namespace);
  const dbPath = `/data/${filePath}`;

  try {
    const { stdout, stderr } = await execInPod(
      kubeconfigPath,
      namespace,
      podName,
      ['sqlite3', '-header', '-csv', dbPath, sql],
    );

    const elapsed = Date.now() - start;

    if (stderr && stderr.toLowerCase().includes('error')) {
      return { columns: [], rows: [], rowCount: 0, executionTimeMs: elapsed, error: stderr };
    }

    const { columns, rows } = parseCsvOutput(stdout);
    return { columns, rows, rowCount: rows.length, executionTimeMs: elapsed };
  } catch (err) {
    const elapsed = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    return { columns: [], rows: [], rowCount: 0, executionTimeMs: elapsed, error: message };
  }
}

/**
 * List all user tables in a SQLite database file.
 */
export async function listTables(
  k8s: K8sClients,
  kubeconfigPath: string | undefined,
  namespace: string,
  filePath: string,
): Promise<readonly string[]> {
  const result = await executeQuery(
    k8s,
    kubeconfigPath,
    namespace,
    filePath,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  if (result.error) {
    throw new ApiError('SQLITE_ERROR', result.error, 500);
  }
  return result.rows.map((r) => r[0]).filter(Boolean);
}

/**
 * Describe the structure (columns) of a table in a SQLite file.
 */
export async function describeTable(
  k8s: K8sClients,
  kubeconfigPath: string | undefined,
  namespace: string,
  filePath: string,
  table: string,
): Promise<readonly ColumnInfo[]> {
  // Validate table name to prevent injection
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(table)) {
    throw new ApiError('INVALID_TABLE_NAME', 'Invalid table name', 400, { table });
  }

  const result = await executeQuery(
    k8s,
    kubeconfigPath,
    namespace,
    filePath,
    `PRAGMA table_info("${table}")`,
  );

  if (result.error) {
    throw new ApiError('SQLITE_ERROR', result.error, 500);
  }

  // PRAGMA table_info columns: cid, name, type, notnull, dflt_value, pk
  return result.rows.map((row) => ({
    name: row[1] ?? '',
    type: row[2] ?? '',
    nullable: row[3] !== '1',
    defaultValue: row[4] || null,
    key: row[5] === '1' ? 'PRI' : '',
  }));
}

/**
 * Browse table data with pagination and ordering.
 */
export async function browseTable(
  k8s: K8sClients,
  kubeconfigPath: string | undefined,
  namespace: string,
  filePath: string,
  table: string,
  options: { readonly limit?: number; readonly offset?: number; readonly orderBy?: string; readonly orderDir?: 'asc' | 'desc' } = {},
): Promise<QueryResult> {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(table)) {
    throw new ApiError('INVALID_TABLE_NAME', 'Invalid table name', 400, { table });
  }

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 1000);
  const offset = Math.max(options.offset ?? 0, 0);
  const orderDir = options.orderDir === 'desc' ? 'DESC' : 'ASC';

  let orderClause = '';
  if (options.orderBy) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(options.orderBy)) {
      throw new ApiError('INVALID_COLUMN_NAME', 'Invalid column name', 400, { column: options.orderBy });
    }
    orderClause = ` ORDER BY "${options.orderBy}" ${orderDir}`;
  }

  return executeQuery(
    k8s,
    kubeconfigPath,
    namespace,
    filePath,
    `SELECT * FROM "${table}"${orderClause} LIMIT ${limit} OFFSET ${offset}`,
  );
}

/**
 * Get the row count of a table.
 */
export async function countRows(
  k8s: K8sClients,
  kubeconfigPath: string | undefined,
  namespace: string,
  filePath: string,
  table: string,
): Promise<number> {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(table)) {
    throw new ApiError('INVALID_TABLE_NAME', 'Invalid table name', 400, { table });
  }

  const result = await executeQuery(
    k8s,
    kubeconfigPath,
    namespace,
    filePath,
    `SELECT COUNT(*) FROM "${table}"`,
  );

  if (result.error) {
    throw new ApiError('SQLITE_ERROR', result.error, 500);
  }

  return parseInt(result.rows[0]?.[0] ?? '0', 10) || 0;
}

/**
 * Export a SQLite database as a SQL dump string.
 */
export async function exportDatabase(
  k8s: K8sClients,
  kubeconfigPath: string | undefined,
  namespace: string,
  filePath: string,
): Promise<string> {
  validateFilePath(filePath);

  const podName = await findFileManagerPod(k8s, namespace);
  const dbPath = `/data/${filePath}`;

  const { stdout, stderr } = await execInPod(
    kubeconfigPath,
    namespace,
    podName,
    ['sqlite3', dbPath, '.dump'],
  );

  if (stderr && stderr.toLowerCase().includes('error')) {
    throw new ApiError('SQLITE_EXPORT_ERROR', stderr, 500);
  }

  return stdout;
}

/**
 * Import SQL into a SQLite database by piping through stdin.
 */
export async function importSql(
  k8s: K8sClients,
  kubeconfigPath: string | undefined,
  namespace: string,
  filePath: string,
  sql: string,
): Promise<ImportResult> {
  validateFilePath(filePath);

  if (Buffer.byteLength(sql, 'utf-8') > MAX_IMPORT_LENGTH) {
    throw new ApiError(
      'IMPORT_TOO_LARGE',
      `SQL import exceeds maximum size of ${MAX_IMPORT_LENGTH} bytes.`,
      400,
      { maxBytes: MAX_IMPORT_LENGTH },
    );
  }

  const podName = await findFileManagerPod(k8s, namespace);
  const dbPath = `/data/${filePath}`;

  try {
    const { stderr } = await execInPodWithStdin(
      kubeconfigPath,
      namespace,
      podName,
      ['sqlite3', dbPath],
      sql,
    );

    if (stderr && stderr.toLowerCase().includes('error')) {
      return { success: false, error: stderr };
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}
