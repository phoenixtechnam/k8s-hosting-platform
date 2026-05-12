/**
 * `mailboxes` component capture (Phase 2 rewrite, 2026-05-11, ADR-036).
 *
 * Replaces the mbsync-based capture path with a JMAP-driven flow. Per
 * tenant client:
 *
 *   1. Resolve every mailbox address belonging to the client from the
 *      platform DB.
 *   2. Look up any prior `tenant_jmap_state.last_jmap_state` per
 *      (client_id, mailbox_address) — feeds incremental Email/changes.
 *   3. Sign ONE HMAC upload token bound to (bundleId, 'mailboxes',
 *      'restic-stream') for the entire client's Maildir tarball.
 *   4. Spawn one Job in the `mail` namespace using the
 *      `mail-backup-tools` image. The Job loops every address and runs
 *      `jmap-sync.py` for each:
 *         a. Reads optional state-in file with prior Email/changes state.
 *         b. Authenticates against the Stalwart JMAP endpoint as
 *            `<addr>%<masterFQ>` (master-user proxy auth — same as the
 *            old mbsync path; one Secret to manage).
 *         c. Pulls created/updated message bodies via Email/get +
 *            Blob/get, writes them into a Maildir-shaped tree at
 *            /tmp/maildir-out/<addr>/<mailbox>/cur/<unix>.<unique>:2,<flags>.
 *         d. Emits a single-line JSON summary on stdout with the new
 *            state token (orchestrator reads from Job log).
 *      After every address finishes, the Job tars /tmp/maildir-out and
 *      streams it to platform-api's restic-stream endpoint — one
 *      snapshot per backup, NOT one per mailbox. Matches the files
 *      component model exactly.
 *
 *   5. Orchestrator parses Job log for JMAP_DONE lines, persists new
 *      state per (client_id, mailbox_jmap_id) AFTER the restic snapshot
 *      is acked. At-least-once: if persistence fails the next run does
 *      a no-op delta (same state token); restic content-dedups.
 *
 * Why JMAP and not IMAP:
 *   - Stalwart 0.16's IMAP MAY return less data than JMAP (some flags +
 *     keywords don't round-trip cleanly via IMAP STORE).
 *   - Email/changes is a server-side delta primitive; mbsync had to
 *     compare UIDVALIDITY + UID per-folder client-side.
 *   - Mailbox renames are stable via Mailbox/changes; IMAP doesn't have
 *     a server-side rename primitive.
 *
 * Auth pattern unchanged from the mbsync era — master-user proxy with
 * `<addr>%<master>` username + master password from `roundcube-secrets`.
 * Same Secret, same rotation flow.
 *
 * Failure modes:
 *   - JMAP auth fails for one address → script exits non-zero, Job
 *     fails (`set -e`), orchestrator marks component failed.
 *   - `cannotCalculateChanges`: jmap-sync.py automatically falls back
 *     to a full pull and writes a fresh state. Reported in stderr;
 *     orchestrator stores it in `tenant_jmap_state.last_error`.
 *   - Blob fetch fails for one message: jmap-sync.py logs + skips;
 *     the message is re-fetched next run (state not advanced for it).
 *   - Empty mailbox: empty Maildir under that address; tar still
 *     proceeds (restic dedups to ~0 bytes for unchanged inputs).
 *
 * Ephemeral storage:
 *   `/tmp/maildir-out` holds the in-flight Maildir for ALL the
 *   client's mailboxes. `emptyDir.sizeLimit: 50Gi` covers the common
 *   case (typical client < 5 GiB mail). For tenants with >50 GiB mail,
 *   the platform should be sharding the client before reaching that
 *   tier anyway.
 */

import { sql, eq } from 'drizzle-orm';
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import type { Database } from '../../../db/index.js';
import { tailJobLog, readJobLogTail } from '../../storage-lifecycle/job-log-tail.js';
import { signUploadToken } from '../upload-token.js';
import { tenantJmapState } from '../../../db/schema.js';

export interface MailboxesComponentResult {
  readonly mailboxCount: number;
  readonly addresses: ReadonlyArray<string>;
  /** Total bytes the restic snapshot reported for this component. */
  readonly sizeBytes: number;
  /** Per-mailbox new state, for the orchestrator to persist AFTER the
   *  restic snapshot is acknowledged. */
  readonly newStates: ReadonlyArray<{
    address: string;
    jmapId: string;
    newState: string;
    fetched: number;
    skipped: number;
    fullPull: boolean;
  }>;
}

export interface CaptureMailboxesComponentOpts {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly clientId: string;
  readonly backupId: string;
  readonly platformApiUrl: string;
  readonly secretsKeyHex: string;
  readonly mailNamespace?: string;       // defaults to 'mail'
  readonly jmapEndpoint?: string;        // defaults to http://stalwart-mgmt.mail.svc.cluster.local:8080
  readonly stalwartMasterUser?: string;  // defaults to 'master@master.local' (FQ)
  readonly masterSecretName?: string;    // defaults to 'roundcube-secrets'
  readonly masterSecretKey?: string;     // defaults to 'STALWART_MASTER_PASSWORD'
  readonly toolsImage?: string;          // defaults to ghcr.io/.../mail-backup-tools:latest
  readonly timeoutMs?: number;
  readonly onProgress?: (msg: string) => Promise<void> | void;
}

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const UPLOAD_TOKEN_TTL_SEC = 60 * 60;
// K8s `activeDeadlineSeconds` is the orchestrator timeout minus this
// buffer so K8s force-kills first and the orchestrator's next poll
// sees `DeadlineExceeded` rather than its own generic timeout.
const JOB_DEADLINE_BUFFER_SEC = 60;
const MAIL_NAMESPACE_DEFAULT = 'mail';
const JMAP_ENDPOINT_DEFAULT = 'http://stalwart-mgmt.mail.svc.cluster.local:8080';
const MASTER_USER_DEFAULT = 'master@master.local';
const MASTER_SECRET_NAME_DEFAULT = 'roundcube-secrets';
const MASTER_SECRET_KEY_DEFAULT = 'STALWART_MASTER_PASSWORD';
const TOOLS_IMAGE_DEFAULT = 'ghcr.io/phoenixtechnam/hosting-platform/mail-backup-tools:latest';
const RESTIC_STREAM_ARTIFACT = 'restic-stream';
const STDIN_FILENAME = 'maildir.tar';

export async function listClientMailboxAddresses(db: Database, clientId: string): Promise<string[]> {
  // `mailboxes.full_address` (camelCase = `fullAddress` per Drizzle
  // convention) is the canonical address column. Audited 2026-05-05.
  const rawDb = db as unknown as { execute: (q: ReturnType<typeof sql>) => Promise<{ rows: { full_address: string }[] }> };
  const r = await rawDb.execute(sql`SELECT full_address FROM mailboxes WHERE client_id = ${clientId} ORDER BY full_address`);
  return r.rows.map((row) => row.full_address);
}

/** Returns prior JMAP state per (client, address). Empty map for first-ever capture. */
async function loadPriorStates(db: Database, clientId: string): Promise<Map<string, { jmapId: string; state: string }>> {
  const rows = await db
    .select({
      jmapId: tenantJmapState.mailboxJmapId,
      address: tenantJmapState.mailboxAddress,
      state: tenantJmapState.lastJmapState,
    })
    .from(tenantJmapState)
    .where(eq(tenantJmapState.clientId, clientId));
  const out = new Map<string, { jmapId: string; state: string }>();
  for (const r of rows) {
    if (r.address && r.state) out.set(r.address, { jmapId: r.jmapId, state: r.state });
  }
  return out;
}

function isSafeAddress(address: string): boolean {
  return /^[A-Za-z0-9._+\-]+@[A-Za-z0-9.\-]+$/.test(address);
}

function isSafeJmapEndpoint(url: string): boolean {
  // The endpoint is interpolated into the shell script body. Limit to
  // http(s) + cluster DNS chars + port. No spaces, no shell metas.
  return /^https?:\/\/[A-Za-z0-9.\-]+(:\d+)?(\/[A-Za-z0-9._\-/]*)?$/.test(url);
}

function isSafeMasterUser(user: string): boolean {
  return /^[A-Za-z0-9._\-]+(@[A-Za-z0-9.\-]+)?$/.test(user);
}

/** Single-quote a string for safe inclusion in a POSIX shell command.
 *  Used for whitelisted values (address, endpoint, master user) that
 *  still benefit from a quoted form so a value like `master@a.b` parses
 *  as one token. The `'` escape is the standard `'\''` POSIX pattern. */
function shQuote(s: string): string {
  if (/^[A-Za-z0-9_./@:-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the K8s Job spec for the JMAP mailboxes-component capture.
 * Pure function — exposed for unit-testing the spec without a kube client.
 */
export function buildMailboxesComponentJobSpec(input: {
  jobName: string;
  mailNamespace: string;
  clientId: string;
  backupId: string;
  toolsImage: string;
  jmapEndpoint: string;
  stalwartMasterUser: string;
  masterSecretName: string;
  masterSecretKey: string;
  /** Full URL (token-less) to the restic-stream endpoint. The script
   *  appends `&token=$TOKEN` after reading the token from the per-Job
   *  Secret mounted at /var/run/upload-token/token. */
  uploadUrlNoToken: string;
  uploadTokenSecretName: string;
  /** Name of the per-Job Secret holding the address→state map at
   *  data.states.json. Mounted read-only at /var/run/jmap-state/states.json. */
  stateSecretName: string;
  addresses: ReadonlyArray<{ address: string; stateIn: string | null }>;
  activeDeadlineSeconds?: number;
}): Record<string, unknown> {
  for (const a of input.addresses) {
    if (!isSafeAddress(a.address)) {
      throw new Error(`buildMailboxesComponentJobSpec: invalid address '${a.address}'`);
    }
  }
  if (!isSafeJmapEndpoint(input.jmapEndpoint)) {
    throw new Error(`buildMailboxesComponentJobSpec: invalid jmapEndpoint '${input.jmapEndpoint}'`);
  }
  if (!isSafeMasterUser(input.stalwartMasterUser)) {
    throw new Error(`buildMailboxesComponentJobSpec: invalid stalwartMasterUser '${input.stalwartMasterUser}'`);
  }

  // Per-mailbox addresses are whitelisted (`isSafeAddress`) so the
  // shell loop can safely interpolate them via a hard-coded `case`
  // dispatch. JMAP state tokens are server-issued opaque strings
  // (RFC 8620 §2) — we MUST NOT pass them through `eval` or `printf`
  // format strings, since a malicious Stalwart server or a poisoned
  // DB row could inject `$(cmd)`. The (address → state) map is
  // mounted as a Secret-backed JSON file at
  // /var/run/jmap-state/states.json; the Job's python3 helper reads
  // it and writes per-mailbox state-in files into the emptyDir
  // scratch. The shell loop never sees a state token directly.
  // The Secret is created separately by `captureMailboxesComponent`
  // and referenced via `input.stateSecretName`.

  const masterPasswordEnv = {
    name: 'STALWART_MASTER_PASSWORD',
    valueFrom: {
      secretKeyRef: {
        name: input.masterSecretName,
        key: input.masterSecretKey,
        optional: false,
      },
    },
  };

  // Script (POSIX sh):
  //   - Read upload token from the mounted Secret (NOT etcd-visible argv).
  //   - For each address: derive its state-in file with python from
  //     the Secret-mounted states.json (state token never goes through
  //     `eval` or `printf` format strings — reviewer-flagged shell
  //     injection vector).
  //   - Run jmap-sync.py per mailbox; append a JMAP_DONE line to the
  //     Job log so the orchestrator can parse summaries from the
  //     bounded job-log tail.
  //   - tar /tmp/maildir-out | curl --upload-file - to the restic-stream
  //     endpoint. Same tar-exit + http-status side-channel pattern as
  //     the files component.
  //   - Echo MAILBOXES_DONE bundleId=... snapshot=... sizeBytes=... .
  //
  // The `seq + case` loop pattern avoids dynamic env-var dereferencing
  // (`eval echo \$VAR_$i`) which would let a poisoned state token
  // execute commands. Each iteration's address is dispatched via a
  // POSIX case statement keyed on the integer index, with the actual
  // string literal embedded at TS-build time (whitelisted by
  // isSafeAddress, so safe to interpolate).
  const caseBranches = input.addresses
    .map((a, i) => `  ${i}) ADDR=${shQuote(a.address)} ;;`)
    .join('\n');
  const script = [
    'set -e',
    'set -o pipefail',
    'TOKEN=$(cat /var/run/upload-token/token)',
    '[ -n "$TOKEN" ] || { echo "ERROR: upload token missing"; exit 1; }',
    'mkdir -p /tmp/maildir-out /tmp/state',
    `COUNT=${input.addresses.length}`,
    'for i in $(seq 0 $((COUNT - 1))); do',
    '  case "$i" in',
    caseBranches,
    '  *) echo "ERROR: invalid index $i"; exit 1 ;;',
    '  esac',
    '  STATE_IN="/tmp/state/${i}.in.json"',
    '  STATE_OUT="/tmp/state/${i}.out.json"',
    // python writes the per-mailbox state-in file by looking up the
    // address in states.json. If the address has no prior state (or
    // an empty string), it writes nothing and STATE_IN is absent →
    // jmap-sync.py does a full pull.
    '  python3 -c "import json,os,sys',
    'addr=sys.argv[1]; out=sys.argv[2]',
    'try: s=json.load(open(\\"/var/run/jmap-state/states.json\\")).get(addr,\\"\\")',
    'except Exception: s=\\"\\"',
    'if s: open(out,\\"w\\").write(json.dumps({\\"state\\": s}))" "$ADDR" "$STATE_IN"',
    '  echo "Capturing mailbox $ADDR (#$i of $COUNT)..." >&2',
    '  if [ -e "$STATE_IN" ]; then',
    `    SUMMARY=$(/usr/local/bin/jmap-sync.py --endpoint ${shQuote(input.jmapEndpoint)} --account-address "$ADDR" --master-user ${shQuote(input.stalwartMasterUser)} --auth-pass-env STALWART_MASTER_PASSWORD --output-dir /tmp/maildir-out --state-in "$STATE_IN" --state-out "$STATE_OUT")`,
    '  else',
    `    SUMMARY=$(/usr/local/bin/jmap-sync.py --endpoint ${shQuote(input.jmapEndpoint)} --account-address "$ADDR" --master-user ${shQuote(input.stalwartMasterUser)} --auth-pass-env STALWART_MASTER_PASSWORD --output-dir /tmp/maildir-out --state-out "$STATE_OUT")`,
    '  fi',
    `  echo "JMAP_DONE bundleId=${input.backupId} address=$ADDR summary=$SUMMARY"`,
    'done',
    'echo "Streaming Maildir tarball to platform-api restic-stream..."',
    `( cd /tmp/maildir-out && tar cf - . 2>/tmp/tar.err; echo $? > /tmp/tar.exit ) | curl --fail-with-body -sS -o /tmp/restic-resp.json -w "%{http_code}" --upload-file - -H "Content-Type: application/x-tar" "${input.uploadUrlNoToken}&token=$TOKEN" > /tmp/http_status`,
    'TAR_EXIT=$(cat /tmp/tar.exit 2>/dev/null || echo "missing")',
    '[ "$TAR_EXIT" = "0" ] || { echo "ERROR: tar exited $TAR_EXIT; tar.err:"; cat /tmp/tar.err 2>/dev/null || true; exit 1; }',
    'HTTP=$(tr -d "\\r\\n " < /tmp/http_status)',
    '[ "$HTTP" = "200" ] || { echo "ERROR: platform-api returned HTTP \\"$HTTP\\""; cat /tmp/restic-resp.json 2>/dev/null || true; exit 1; }',
    'SNAP=$(grep -o \'"snapshotId":"[0-9a-f]\\{64\\}"\' /tmp/restic-resp.json | sed \'s/.*":"//;s/"$//\')',
    '[ -n "$SNAP" ] || { echo "ERROR: no snapshotId in response"; cat /tmp/restic-resp.json; exit 1; }',
    'SIZE=$(grep -o \'"sizeBytes":[0-9]\\+\' /tmp/restic-resp.json | sed \'s/.*://\')',
    `echo "MAILBOXES_DONE bundleId=${input.backupId} snapshot=$SNAP sizeBytes=\${SIZE:-0}"`,
  ].join('\n');

  return {
    metadata: {
      name: input.jobName,
      namespace: input.mailNamespace,
      labels: {
        'platform.io/component': 'backup-files',
        'platform.io/client-id': input.clientId,
        'platform.io/backup-id': input.backupId,
        'platform.io/sub-component': 'backup-mailboxes',
      },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      ...(input.activeDeadlineSeconds && input.activeDeadlineSeconds > 0
        ? { activeDeadlineSeconds: input.activeDeadlineSeconds }
        : {}),
      template: {
        metadata: {
          labels: {
            'platform.io/component': 'backup-files',
            'platform.io/client-id': input.clientId,
            'platform.io/backup-id': input.backupId,
            'platform.io/sub-component': 'backup-mailboxes',
          },
        },
        spec: {
          restartPolicy: 'Never',
          priorityClassName: 'platform-tenant-overhead',
          containers: [{
            name: 'mailboxes',
            image: input.toolsImage,
            // Always pull: the mail-backup-tools image is published
            // with `:latest` floating to the newest build, but worker
            // nodes cache by tag. Without Always, a cached older
            // image (e.g. pre-Phase 2, no jmap-sync.py) silently runs
            // and the Job fails with `jmap-sync.py: not found`
            // (caught 2026-05-11 mid-deploy). Image is small (<120 MiB)
            // so the pull cost is minor.
            imagePullPolicy: 'Always',
            command: ['sh', '-c', script],
            env: [
              masterPasswordEnv,
            ],
            resources: {
              requests: { cpu: '100m', memory: '256Mi' },
              limits: { cpu: '1500m', memory: '1Gi' },
            },
            volumeMounts: [
              { name: 'scratch', mountPath: '/tmp' },
              { name: 'upload-token', mountPath: '/var/run/upload-token', readOnly: true },
              { name: 'jmap-state', mountPath: '/var/run/jmap-state', readOnly: true },
            ],
          }],
          volumes: [
            // 50Gi for the in-flight Maildir tree. Tarball never lands
            // on disk — streamed end-to-end via curl --upload-file -.
            { name: 'scratch', emptyDir: { sizeLimit: '50Gi' } },
            {
              name: 'upload-token',
              secret: {
                secretName: input.uploadTokenSecretName,
                defaultMode: 0o400,
                items: [{ key: 'token', path: 'token' }],
              },
            },
            {
              // address → JMAP state map (server-issued opaque tokens).
              // Mounted read-only; the python helper inside the script
              // reads it without exposing the tokens to the shell.
              name: 'jmap-state',
              secret: {
                secretName: input.stateSecretName,
                defaultMode: 0o400,
                items: [{ key: 'states.json', path: 'states.json' }],
              },
            },
          ],
        },
      },
    },
  };
}

/**
 * Idempotent create of the per-Job state Secret. data.states.json is
 * the JSON map `{address: state-token}`. Mounted read-only in the
 * Job's pod so the python helper can derive per-mailbox state-in
 * files WITHOUT the opaque tokens ever passing through shell.
 *
 * AlreadyExists (409) is tolerated — the orchestrator may retry the
 * Job create and we want the second call to reuse the existing
 * Secret content (it's deterministic per bundleId).
 */
async function createStateSecret(
  k8s: K8sClients,
  namespace: string,
  name: string,
  statesJson: string,
): Promise<void> {
  const body = {
    metadata: {
      name,
      namespace,
      labels: {
        'platform.io/component': 'backup-mailboxes',
        'platform.io/managed-by': 'tenant-bundles',
      },
    },
    type: 'Opaque',
    stringData: { 'states.json': statesJson },
  };
  try {
    // backup-coverage: excluded:transient-job-state
    await (k8s.core as unknown as {
      createNamespacedSecret: (args: { namespace: string; body: unknown }) => Promise<unknown>;
    }).createNamespacedSecret({ namespace, body });
  } catch (err) {
    const httpErr = err as { code?: number; statusCode?: number };
    const code = httpErr.code ?? httpErr.statusCode;
    if (code === 409) return;
    throw err;
  }
}

/**
 * Idempotent create of the per-Job upload-token Secret. Mirrors the
 * pattern in files.ts:createTokenSecret. The orchestrator wires the
 * Job's ownerReferences onto this Secret after Job create so
 * kube-controller-manager GCs the Secret with the Job.
 */
async function createUploadTokenSecret(
  k8s: K8sClients,
  namespace: string,
  name: string,
  token: string,
): Promise<void> {
  const body = {
    metadata: {
      name,
      namespace,
      labels: {
        'platform.io/component': 'backup-mailboxes',
        'platform.io/managed-by': 'tenant-bundles',
      },
    },
    type: 'Opaque',
    stringData: { token },
  };
  try {
    // backup-coverage: excluded:transient-job-token
    await (k8s.core as unknown as {
      createNamespacedSecret: (args: { namespace: string; body: unknown }) => Promise<unknown>;
    }).createNamespacedSecret({ namespace, body });
  } catch (err) {
    const httpErr = err as { code?: number; statusCode?: number };
    const code = httpErr.code ?? httpErr.statusCode;
    if (code === 409) return; // AlreadyExists — idempotent retry.
    throw err;
  }
}

export async function captureMailboxesComponent(
  opts: CaptureMailboxesComponentOpts,
): Promise<MailboxesComponentResult> {
  const addresses = await listClientMailboxAddresses(opts.db, opts.clientId);
  if (addresses.length === 0) {
    return { mailboxCount: 0, addresses: [], sizeBytes: 0, newStates: [] };
  }

  const priorStates = await loadPriorStates(opts.db, opts.clientId);
  const perAddress = addresses.map((address) => ({
    address,
    stateIn: priorStates.get(address)?.state ?? null,
  }));

  const archiveToken = signUploadToken(
    {
      bundleId: opts.backupId,
      component: 'mailboxes',
      artifactName: RESTIC_STREAM_ARTIFACT,
      ttlSeconds: UPLOAD_TOKEN_TTL_SEC,
    },
    opts.secretsKeyHex,
  );

  const mailNamespace = opts.mailNamespace ?? MAIL_NAMESPACE_DEFAULT;
  const apiBase = opts.platformApiUrl.replace(/\/$/, '');
  const uploadUrlNoToken =
    `${apiBase}/api/v1/internal/bundles/${opts.backupId}` +
    `/components/mailboxes/restic-stream` +
    `?filename=${encodeURIComponent(STDIN_FILENAME)}`;

  const jobName = `bk-mbox-${opts.backupId}`.slice(0, 63);
  const tokenSecretName = `bk-mbox-token-${opts.backupId}`.slice(0, 63);
  const stateSecretName = `bk-mbox-state-${opts.backupId}`.slice(0, 63);
  const orchestratorTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  await createUploadTokenSecret(opts.k8s, mailNamespace, tokenSecretName, archiveToken);
  // Per-mailbox state map — Secret-mounted so opaque JMAP state
  // tokens never traverse env vars or shell expansion (reviewer-
  // flagged shell-injection vector).
  const statesJson = JSON.stringify(
    Object.fromEntries(perAddress.map((a) => [a.address, a.stateIn ?? ''])),
  );
  await createStateSecret(opts.k8s, mailNamespace, stateSecretName, statesJson);

  const spec = buildMailboxesComponentJobSpec({
    jobName,
    mailNamespace,
    clientId: opts.clientId,
    backupId: opts.backupId,
    toolsImage: opts.toolsImage ?? TOOLS_IMAGE_DEFAULT,
    jmapEndpoint: opts.jmapEndpoint ?? JMAP_ENDPOINT_DEFAULT,
    stalwartMasterUser: opts.stalwartMasterUser ?? MASTER_USER_DEFAULT,
    masterSecretName: opts.masterSecretName ?? MASTER_SECRET_NAME_DEFAULT,
    masterSecretKey: opts.masterSecretKey ?? MASTER_SECRET_KEY_DEFAULT,
    uploadUrlNoToken,
    uploadTokenSecretName: tokenSecretName,
    stateSecretName,
    addresses: perAddress,
    activeDeadlineSeconds: Math.max(60, Math.ceil(orchestratorTimeoutMs / 1000) - JOB_DEADLINE_BUFFER_SEC),
  });

  await (opts.k8s.batch as unknown as {
    createNamespacedJob: (a: { namespace: string; body: unknown }) => Promise<unknown>;
  }).createNamespacedJob({ namespace: mailNamespace, body: spec });

  await waitForJob(opts.k8s, mailNamespace, jobName, orchestratorTimeoutMs, opts.onProgress);

  // Parse Job log for JMAP_DONE + MAILBOXES_DONE lines. We need the
  // FULL multi-line log (one JMAP_DONE per mailbox), not the
  // single-last-line summary that tailJobLog returns for progress.
  const log = await readJobLogTail(opts.k8s, mailNamespace, jobName, { tailLines: 500 }).catch(() => null);
  const { newStates, sizeBytes } = parseMailboxesDone(log ?? '', opts.backupId);

  return {
    mailboxCount: addresses.length,
    addresses,
    sizeBytes,
    newStates,
  };
}

/**
 * Parse JMAP_DONE + MAILBOXES_DONE lines from the Job log.
 *
 * `JMAP_DONE bundleId=<id> address=<addr> summary=<json>` — one per mailbox.
 *   summary is the JSON object jmap-sync.py emits on stdout:
 *     { "address": ..., "fetched": N, "skipped": M, "newState": "...", "fullPull": bool }
 *
 * `MAILBOXES_DONE bundleId=<id> snapshot=<64hex> sizeBytes=<n>` — one final line.
 *
 * Exported for unit-testing without spinning a Job.
 */
export function parseMailboxesDone(
  log: string,
  expectedBundleId: string,
): {
  newStates: Array<{
    address: string;
    jmapId: string;
    newState: string;
    fetched: number;
    skipped: number;
    fullPull: boolean;
  }>;
  sizeBytes: number;
} {
  const newStates: Array<{
    address: string;
    jmapId: string;
    newState: string;
    fetched: number;
    skipped: number;
    fullPull: boolean;
  }> = [];
  let sizeBytes = 0;
  for (const line of log.split('\n')) {
    const jmapMatch = line.match(/JMAP_DONE bundleId=(\S+) address=(\S+) summary=(\{.*\})\s*$/);
    if (jmapMatch && jmapMatch[1] === expectedBundleId) {
      try {
        const summary = JSON.parse(jmapMatch[3]!) as {
          address: string;
          fetched: number;
          skipped: number;
          newState: string;
          fullPull: boolean;
        };
        newStates.push({
          address: jmapMatch[2]!,
          // jmap-sync.py doesn't expose accountId in the summary today;
          // we use the address as a stable proxy. The schema allows
          // address as a separate column already (`mailbox_address`);
          // the `mailbox_jmap_id` column gets the same value for now
          // until jmap-sync emits the JMAP accountId in a future tweak.
          jmapId: jmapMatch[2]!,
          newState: summary.newState ?? '',
          fetched: summary.fetched ?? 0,
          skipped: summary.skipped ?? 0,
          fullPull: !!summary.fullPull,
        });
      } catch {
        // Malformed summary — skip; the orchestrator will not persist
        // state for this mailbox so the next run re-pulls fresh.
      }
      continue;
    }
    const mboxMatch = line.match(/MAILBOXES_DONE bundleId=(\S+) snapshot=([0-9a-f]{64}) sizeBytes=(\d+)/);
    if (mboxMatch && mboxMatch[1] === expectedBundleId) {
      sizeBytes = Number.parseInt(mboxMatch[3]!, 10);
    }
  }
  return { newStates, sizeBytes };
}

async function waitForJob(
  k8s: K8sClients,
  namespace: string,
  jobName: string,
  timeoutMs: number,
  onProgress?: (msg: string) => Promise<void> | void,
): Promise<void> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = await (k8s.batch as unknown as {
      readNamespacedJob: (a: { name: string; namespace: string }) => Promise<{
        status?: {
          conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>;
          succeeded?: number;
          failed?: number;
        };
      }>;
    }).readNamespacedJob({ name: jobName, namespace });

    const status = job.status ?? {};
    const completed = (status.conditions ?? []).find((c) => c.type === 'Complete' && c.status === 'True');
    const failed = (status.conditions ?? []).find((c) => c.type === 'Failed' && c.status === 'True');
    if (completed || (status.succeeded ?? 0) > 0) return;
    if (failed || (status.failed ?? 0) > 0) {
      throw new Error(`mailboxes-component Job ${jobName} failed: ${failed?.message ?? 'unknown'}`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`mailboxes-component Job ${jobName} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    if (onProgress) {
      const tail = await tailJobLog(k8s, namespace, jobName, { tailLines: 5, maxLineLength: 200 }).catch(() => null);
      await onProgress(tail ? `mailboxes: ${tail}` : 'Capturing mailboxes…');
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
}
