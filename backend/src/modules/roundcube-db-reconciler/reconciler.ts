/**
 * Roundcube DB password self-healer.
 *
 * Roundcube authenticates to the platform-CNPG `roundcube` Postgres
 * role using the password stored in `mail/roundcube-secrets`
 * (key `ROUNDCUBEMAIL_DB_PASSWORD`). The same password is also
 * written into Postgres at bootstrap time by `create_roundcube_db()`
 * in `scripts/bootstrap.sh`. If those two values drift — operator
 * rotated the Secret manually, a partial re-bootstrap regenerated
 * the Secret but skipped the DB step, or any of a dozen other
 * scenarios — Roundcube logs:
 *
 *   FATAL: password authentication failed for user "roundcube"
 *
 * and the webmail page renders an "Internal Error" 500.
 *
 * This reconciler closes that drift gap. On platform-api startup AND
 * on a 5-minute timer thereafter:
 *
 *   1. Read `roundcube-secrets.ROUNDCUBEMAIL_DB_PASSWORD`.
 *   2. Find the CNPG primary pod (`cnpg.io/cluster=system-db,
 *      role=primary`).
 *   3. `kubectl exec` psql with idempotent SQL that:
 *        - CREATEs the `roundcube` role if absent; ALTERs its
 *          password to match the Secret regardless
 *        - CREATEs the `roundcube` database if absent
 *        - GRANTs full privileges to the role on the database
 *
 * Failure is non-fatal — the reconciler logs and waits for the next
 * tick. The function returns a result struct callers can inspect.
 *
 * Skipped when:
 *   - `mail/roundcube-secrets` Secret does not exist (mail stack not
 *     deployed yet — fresh install, or operator opted out).
 *   - The CNPG primary pod is not found (system-db not yet Ready).
 *
 * Required RBAC (already granted in `k8s/base/rbac.yaml`):
 *   - `secrets:get` in the `mail` namespace
 *   - `pods:get,list` in the `platform` namespace
 *   - `pods/exec:get,create` in the `platform` namespace
 */
import * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';
import { PassThrough, Writable } from 'node:stream';

export const ROUNDCUBE_SECRET_NAMESPACE = 'mail';
export const ROUNDCUBE_SECRET_NAME = 'roundcube-secrets';
export const ROUNDCUBE_SECRET_PASSWORD_KEY = 'ROUNDCUBEMAIL_DB_PASSWORD';
export const CNPG_CLUSTER_NAMESPACE = 'platform';
export const CNPG_CLUSTER_NAME = 'system-db';

export interface RoundcubeDbReconcileResult {
  readonly skipped: boolean;
  readonly skipReason?: 'secret_missing' | 'password_missing' | 'primary_pod_missing';
  readonly applied: boolean;
  readonly stderr?: string;
}

/**
 * Read a single field from a Kubernetes Secret. Returns null on
 * not-found / forbidden / missing-key — the caller decides how to
 * handle absence (the reconciler treats it as a skip, not a fatal).
 */
async function readSecretValue(
  core: k8s.CoreV1Api,
  namespace: string,
  name: string,
  key: string,
): Promise<string | null> {
  try {
    const secret = (await core.readNamespacedSecret({
      namespace,
      name,
    } as unknown as Parameters<typeof core.readNamespacedSecret>[0])) as {
      data?: Record<string, string>;
    };
    const b64 = secret.data?.[key];
    if (!b64) return null;
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

async function findCnpgPrimaryPod(
  core: k8s.CoreV1Api,
  namespace: string,
  clusterName: string,
): Promise<string | null> {
  try {
    const list = (await core.listNamespacedPod({
      namespace,
      labelSelector: `cnpg.io/cluster=${clusterName},role=primary`,
    } as unknown as Parameters<typeof core.listNamespacedPod>[0])) as {
      items?: ReadonlyArray<{ metadata?: { name?: string } }>;
    };
    const name = list.items?.[0]?.metadata?.name;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

/**
 * Run a command in a pod and collect stdout + stderr + exit status.
 * Stream-based to honour the @kubernetes/client-node Exec API; the
 * caller passes a stdin string for psql heredoc-style SQL injection.
 *
 * Times out after 15s — the entire roundcube_db SQL block is a
 * handful of statements; 15s is generous.
 */
async function execStdin(
  exec: k8s.Exec,
  namespace: string,
  podName: string,
  containerName: string,
  argv: string[],
  stdin: string,
): Promise<{ stdout: string; stderr: string; success: boolean }> {
  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutSink = new PassThrough();
    stdoutSink.on('data', (c: Buffer) => stdoutChunks.push(c));
    const stderrSink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        stderrChunks.push(chunk);
        cb();
      },
    });
    const stdinSource = new PassThrough();

    const timer = setTimeout(() => {
      reject(new Error(`roundcube-db psql exec timed out after 15s`));
    }, 15_000);

    exec
      .exec(
        namespace,
        podName,
        containerName,
        argv,
        stdoutSink,
        stderrSink,
        stdinSource,
        false,
        (status) => {
          clearTimeout(timer);
          resolve({
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
            success: status.status !== 'Failure',
          });
        },
      )
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });

    stdinSource.write(stdin);
    stdinSource.end();
  });
}

/**
 * Build the idempotent SQL block. Mirrors `create_roundcube_db()` in
 * bootstrap.sh so behaviour is consistent across the install and
 * runtime convergence paths.
 *
 * Injection-safety strategy: the password is assigned to a psql
 * variable on the CLI via `psql -v rcpw=<value>`. The SQL references
 * it as `:'rcpw'` which psql substitutes with the SQL-literal form
 * (single-quoted, with embedded quotes doubled and backslashes
 * escaped). Same primitive psql clients use everywhere.
 *
 * The DO block can't see psql variables (they don't substitute
 * inside `$$...$$`), so we use the `\gexec` trick instead: emit the
 * literal CREATE/ALTER statement from a SELECT, then `\gexec` runs
 * it. `quote_literal()` server-side handles the SQL-string escaping
 * inside the emitted statement, so the password is double-escaped:
 * once by psql substitution, once by `quote_literal()`.
 */
function buildSql(): string {
  return [
    // `\gexec` runs the SELECT result as a new SQL statement. We
    // pick CREATE or ALTER depending on whether the role already
    // exists. `quote_literal(:'rcpw')` server-side-quotes the value.
    `SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'roundcube')`,
    `       THEN 'ALTER ROLE roundcube WITH LOGIN PASSWORD ' || quote_literal(:'rcpw')`,
    `       ELSE 'CREATE ROLE roundcube LOGIN PASSWORD ' || quote_literal(:'rcpw')`,
    `       END \\gexec`,
    // Database. \gexec same trick: only emit the CREATE if it's missing.
    `SELECT 'CREATE DATABASE roundcube OWNER roundcube'`,
    `  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'roundcube') \\gexec`,
    `GRANT ALL PRIVILEGES ON DATABASE roundcube TO roundcube;`,
  ].join('\n');
}

/**
 * Sync the `roundcube` Postgres role's password to match what's in
 * `roundcube-secrets`. Idempotent — running on every boot + 5-min
 * tick converges the live state to the Secret with no churn when
 * already in sync (psql exits 0; logs the noop).
 */
export async function reconcileRoundcubeDb(
  core: k8s.CoreV1Api,
  kc: k8s.KubeConfig,
  log: Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>,
): Promise<RoundcubeDbReconcileResult> {
  // Step 1: read the Secret. Missing Secret means the mail stack
  // isn't deployed — skip cleanly.
  const password = await readSecretValue(
    core,
    ROUNDCUBE_SECRET_NAMESPACE,
    ROUNDCUBE_SECRET_NAME,
    ROUNDCUBE_SECRET_PASSWORD_KEY,
  );
  if (password === null) {
    return { skipped: true, skipReason: 'secret_missing', applied: false };
  }
  if (password.length === 0) {
    return { skipped: true, skipReason: 'password_missing', applied: false };
  }

  // Step 2: find the CNPG primary pod. Missing means system-db is
  // not Ready (rare except during initial bootstrap or a CNPG
  // failover transient) — skip.
  const podName = await findCnpgPrimaryPod(
    core,
    CNPG_CLUSTER_NAMESPACE,
    CNPG_CLUSTER_NAME,
  );
  if (!podName) {
    return { skipped: true, skipReason: 'primary_pod_missing', applied: false };
  }

  // Step 3: build the SQL + exec. psql `-v rcpw=value` threads the
  // password into the script as a psql variable. `quote_literal()`
  // server-side handles SQL-string escaping for the password.
  const sql = buildSql();

  const exec = new k8s.Exec(kc);
  let result: { stdout: string; stderr: string; success: boolean };
  try {
    result = await execStdin(
      exec,
      CNPG_CLUSTER_NAMESPACE,
      podName,
      'postgres',
      // -X disables .psqlrc; -v assigns the password var; --quiet
      // silences the per-statement chatter on the wire.
      [
        'psql',
        '-X',
        '--quiet',
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-v',
        `rcpw=${password}`,
      ],
      sql,
    );
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), pod: podName },
      'roundcube-db-reconciler: psql exec failed',
    );
    return {
      skipped: false,
      applied: false,
      stderr: err instanceof Error ? err.message : String(err),
    };
  }

  if (!result.success) {
    log.warn(
      { stderr: result.stderr.slice(0, 500), pod: podName },
      'roundcube-db-reconciler: psql returned non-zero',
    );
    return { skipped: false, applied: false, stderr: result.stderr };
  }

  log.info(
    { pod: podName, stdoutLen: result.stdout.length },
    'roundcube-db-reconciler: converged roundcube role password to Secret',
  );
  return { skipped: false, applied: true, stderr: result.stderr };
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export interface RoundcubeDbReconcilerHandle {
  readonly stop: () => void;
}

/**
 * Schedule the reconciler. Calls once immediately for fast convergence
 * on boot, then every `intervalMs` (default 5 min). Returns a handle
 * the caller can stop on shutdown.
 */
export function startRoundcubeDbReconciler(
  core: k8s.CoreV1Api,
  kc: k8s.KubeConfig,
  log: Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): RoundcubeDbReconcilerHandle {
  let cancelled = false;
  const tick = async () => {
    if (cancelled) return;
    try {
      await reconcileRoundcubeDb(core, kc, log);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'roundcube-db-reconciler: tick threw',
      );
    }
  };
  // First run on next tick so callers can finish boot wiring before
  // it fires. Use setImmediate rather than awaiting here to keep
  // startup non-blocking.
  setImmediate(tick);
  const timer = setInterval(tick, intervalMs);
  // unref so a stuck reconciler doesn't keep the process alive.
  timer.unref();
  return {
    stop: () => {
      cancelled = true;
      clearInterval(timer);
    },
  };
}
