/**
 * Restore executor: `mailboxes-by-address` (Phase 2 of ADR-036 rewrite,
 * 2026-05-11).
 *
 * Switched from IMAP APPEND (`restore-mailbox.py`) to JMAP Blob/upload +
 * Email/import (`jmap-restore.py`). Real-world measurement on staging:
 *   - IMAP path:  916s for 980 messages  (~1 msg/sec)
 *   - JMAP path: ~15-30s for 980 messages (~30-70 msg/sec)
 *
 * Flow:
 *   1. For 'addresses' selector: validate addresses + sanitise.
 *      For 'all' selector: enumerate the bundle's mailboxes
 *      component (same artefact-name → address mapping as capture).
 *   2. Sign one HMAC download token per address.
 *   3. Spawn a Job in the `mail` namespace using mail-backup-tools.
 *      For each address the Job:
 *        a. curl downloads `<addr>.mbox.tar.gz` to /tmp.
 *        b. tar -xzf into /tmp/maildir/.
 *        c. python3 /usr/local/bin/jmap-restore.py
 *             --endpoint http://stalwart-mgmt.mail.svc.cluster.local:8080
 *             --target-address <addr> --source-address <addr>
 *             --master-user master@master.local
 *             --auth-pass-env STALWART_MASTER_PASSWORD
 *             --maildir-root /tmp/maildir
 *             --mode <mode> --workers 16
 *        d. rm -rf the maildir before the next address.
 *
 * Per-address shell loop uses POSIX `case "$i"` dispatch (same security
 * pattern as the capture executor — see tenant-bundles/components/
 * mailboxes.ts) so an attacker cannot inject through MAILBOX_ADDR_<i>
 * env values even if the upstream isSafeAddress() check were bypassed.
 *
 * Mode plumbing:
 *   The restore mode lives in the selector (mailboxRestoreModeSchema):
 *     - merge-skip-duplicates (default)        — JMAP dedup by Message-ID
 *     - merge-overwrite                        — JMAP import, no dedup
 *     - replace (requires confirmDestructive)  — JMAP pre-purge then import
 *   The schema's superRefine enforces the typed-confirmation pattern;
 *   the executor reads selector.mode (defaulting to merge-skip).
 *
 * Idempotency contract (per ADR-034 §3):
 *   merge-skip-duplicates is fully idempotent — re-running is safe.
 *   merge-overwrite is monotonic (each run appends without dedup).
 *   replace is destructive but crash-safe (pre-purge is one Email/set
 *   destroy batch; failure between purge and import leaves an empty
 *   account that the retry will re-fill).
 *
 * Stalwart account existence: jmap-restore.py REQUIRES the target
 * principal to exist (otherwise auth fails). The cart's
 * `ensureStalwartPrincipal` step (see ./recreate-principal.ts) runs
 * BEFORE this executor when restoring an account whose principal was
 * deleted in Stalwart.
 *
 * Rollback: the legacy IMAP restore-mailbox.py stays in the
 * mail-backup-tools image. To re-enable the IMAP path, set
 * `MAILBOX_RESTORE_METHOD=imap` in the platform-api env — the
 * executor falls back to the pre-2026-05-11 script.
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { BackupStore } from '../../tenant-bundles/bundle-store.js';
import { restoreItems, restoreJobs, type RestoreItem } from '../../../db/schema.js';
import { ApiError } from '../../../shared/errors.js';
import { signUploadToken } from '../../tenant-bundles/upload-token.js';
import { tailJobLog } from '../../storage-lifecycle/job-log-tail.js';
import { createK8sClients, type K8sClients } from '../../k8s-provisioner/k8s-client.js';
import { ensureStalwartPrincipals } from './ensure-stalwart-principals.js';
import {
  type MailboxRestoreMode,
  MAILBOX_RESTORE_MODE_DEFAULT,
} from '@k8s-hosting/api-contracts';

interface Selector {
  kind: 'all' | 'addresses';
  addresses?: readonly string[];
  mode?: MailboxRestoreMode;
  confirmDestructive?: boolean;
}

const MAIL_NAMESPACE = 'mail';
// JMAP capture and restore share the same in-cluster mgmt endpoint —
// see tenant-bundles/components/mailboxes.ts for the rationale on
// preferring the HTTP mgmt service over the public HTTPS ingress
// (cert verification + cluster-local routing).
const JMAP_ENDPOINT_DEFAULT = 'http://stalwart-mgmt.mail.svc.cluster.local:8080';
// Stalwart master-user proxy needs the FQ master account
// (master@master.local). The short-form 'master' resolves to
// master@localhost.local which doesn't exist → AUTHENTICATIONFAILED.
// See tenant-bundles/components/mailboxes.ts for the rationale.
const MASTER_USER_DEFAULT = 'master@master.local';
const MASTER_SECRET_NAME_DEFAULT = 'roundcube-secrets';
const MASTER_SECRET_KEY_DEFAULT = 'STALWART_MASTER_PASSWORD';
const TOOLS_IMAGE_DEFAULT = 'ghcr.io/phoenixtechnam/hosting-platform/mail-backup-tools:latest';
const DOWNLOAD_TOKEN_TTL_SEC = 60 * 60;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
// Parallelism for Blob/upload from a single jmap-restore.py invocation.
// Stalwart's bumped maxConcurrentUploads=32 caps the upper bound;
// 16 leaves headroom for backup-and-restore-at-the-same-time.
const RESTORE_WORKERS_DEFAULT = 16;

const VALID_MODES: ReadonlySet<MailboxRestoreMode> = new Set([
  'merge-skip-duplicates',
  'merge-overwrite',
  'replace',
]);

function isSafeAddress(address: string): boolean {
  return /^[A-Za-z0-9._+\-]+@[A-Za-z0-9.\-]+$/.test(address);
}

function isSafeJmapEndpoint(url: string): boolean {
  // http://host[.port][/path] or https://… — no shell-meaningful chars.
  // We embed this verbatim into a JMAP --endpoint argv; jmap-restore.py
  // will resolve the /.well-known/jmap path itself.
  return /^https?:\/\/[A-Za-z0-9.\-]+(:\d+)?(\/[A-Za-z0-9._~:/?#@!$&'()*+,;=\-]*)?$/.test(url);
}

function isSafeMasterUser(user: string): boolean {
  // Stalwart needs `<local>@<domain>`; bare alphanumeric form is
  // tolerated for legacy / non-Stalwart servers.
  return /^[A-Za-z0-9._\-]+(@[A-Za-z0-9.\-]+)?$/.test(user);
}

export async function execMailboxesByAddressItem(args: {
  app: FastifyInstance;
  item: RestoreItem;
  store: BackupStore;
}): Promise<void> {
  const { app, item, store } = args;
  const selector = item.selector as unknown as Selector;

  // Mode: default merge-skip-duplicates. Replace requires explicit
  // confirmDestructive flag (defence-in-depth — the contract
  // superRefine enforces this at API boundary too).
  const mode: MailboxRestoreMode = selector.mode ?? MAILBOX_RESTORE_MODE_DEFAULT;
  if (!VALID_MODES.has(mode)) {
    throw new ApiError('VALIDATION_ERROR', `mailboxes-by-address: invalid mode '${mode}'`, 400);
  }
  if (mode === 'replace' && selector.confirmDestructive !== true) {
    throw new ApiError(
      'CONFIRMATION_REQUIRED',
      `mailbox restore mode 'replace' is destructive — set confirmDestructive: true to proceed`,
      400,
    );
  }

  const [job] = await app.db.select().from(restoreJobs).where(eq(restoreJobs.id, item.restoreJobId)).limit(1);
  if (!job) throw new ApiError('NOT_FOUND', `Restore job ${item.restoreJobId} not found`, 404);

  // Resolve target addresses.
  let addresses: readonly string[];
  if (selector.kind === 'all') {
    const handle = await store.open(item.bundleId);
    if (!handle) throw new ApiError('NOT_FOUND', `Bundle ${item.bundleId} not found on remote target`, 404);
    const refs = await store.listArtifacts(handle, 'mailboxes');
    addresses = refs.map((r) => r.name.replace(/\.mbox\.tar\.gz$/, '')).filter((s) => s.length > 0);
    if (addresses.length === 0) {
      await app.db.update(restoreItems)
        .set({ progressMessage: 'mailboxes-by-address: bundle contains no mailboxes' })
        .where(eq(restoreItems.id, item.id));
      return;
    }
  } else if (selector.kind === 'addresses' && Array.isArray(selector.addresses) && selector.addresses.length > 0) {
    for (const a of selector.addresses) {
      if (!isSafeAddress(a)) {
        throw new ApiError('VALIDATION_ERROR', `mailboxes-by-address: invalid address '${a}'`, 400);
      }
    }
    addresses = selector.addresses;
  } else {
    throw new Error(`mailboxes-by-address: unsupported selector ${JSON.stringify(selector)}`);
  }

  const platformApiUrl = (app.config as Record<string, unknown>).PLATFORM_API_INTERNAL_URL as string | undefined
    ?? process.env.PLATFORM_API_INTERNAL_URL
    ?? 'http://platform-api.platform.svc:3000';
  const configuredKey = (app.config as Record<string, unknown>).PLATFORM_ENCRYPTION_KEY as string | undefined
    ?? process.env.PLATFORM_ENCRYPTION_KEY;
  if (!configuredKey) {
    app.log.error(
      { module: 'mailboxes-by-address-restore' },
      'PLATFORM_ENCRYPTION_KEY missing — falling back to a zero-key. HMAC tokens for download URLs will be predictable; restore will only succeed if capture-side ran with the same fallback.',
    );
  }
  const secretsKeyHex = configuredKey ?? '0'.repeat(64);

  // Ensure each target principal exists in Stalwart BEFORE shipping
  // the restore Job — otherwise jmap-restore.py would fail per address
  // with `unauthorized` and we'd waste the Job's setup cost. The
  // helper:
  //   - leaves existing principals untouched
  //   - recreates missing principals using metadata from the platform
  //     mailboxes DB row (run a `config-tables(mailboxes)` cart item
  //     FIRST when restoring a fully-deleted account so the DB row
  //     is recreated before this executor runs)
  //   - surfaces MAILBOX_ROW_MISSING if BOTH Stalwart and the DB are
  //     missing this address — operators get a clear remediation path
  const ensure = await ensureStalwartPrincipals({ app, addresses });
  const failedEnsures = ensure.outcomes.filter((o) => o.status === 'failed');
  if (failedEnsures.length > 0) {
    const detail = failedEnsures
      .map((o) => `${o.address}: ${o.reason}`)
      .join('; ');
    throw new ApiError(
      'PRINCIPAL_ENSURE_FAILED',
      `Could not ensure Stalwart principals before restore: ${detail}`,
      409,
    );
  }
  if (ensure.recreated > 0) {
    app.log.info(
      { module: 'mailboxes-by-address-restore', recreated: ensure.recreated, addresses: addresses.length },
      'recreated Stalwart principals for restore — placeholder secrets are random; operator should rotate user-facing passwords',
    );
  }

  const downloads = addresses.map((address) => ({
    address,
    token: signUploadToken(
      { bundleId: item.bundleId, component: 'mailboxes', artifactName: `${address}.mbox.tar.gz`, ttlSeconds: DOWNLOAD_TOKEN_TTL_SEC },
      secretsKeyHex,
    ),
  }));

  const downloadBase = `${platformApiUrl.replace(/\/$/, '')}/api/v1/internal/bundles/${item.bundleId}/components/mailboxes`;
  const jobName = `rs-mbox-${item.id.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 50)}`;
  const spec = buildMailboxesByAddressJobSpec({
    jobName,
    mailNamespace: MAIL_NAMESPACE,
    clientId: job.clientId,
    cartId: item.restoreJobId,
    itemId: item.id,
    toolsImage: TOOLS_IMAGE_DEFAULT,
    jmapEndpoint: JMAP_ENDPOINT_DEFAULT,
    stalwartMasterUser: MASTER_USER_DEFAULT,
    masterSecretName: MASTER_SECRET_NAME_DEFAULT,
    masterSecretKey: MASTER_SECRET_KEY_DEFAULT,
    mode,
    downloadBase,
    downloads,
    workers: RESTORE_WORKERS_DEFAULT,
  });

  const kc = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined
    ?? process.env.KUBECONFIG;
  const k8s: K8sClients = createK8sClients(kc);
  await (k8s.batch as unknown as {
    createNamespacedJob: (a: { namespace: string; body: unknown }) => Promise<unknown>;
  }).createNamespacedJob({ namespace: MAIL_NAMESPACE, body: spec });

  await waitForJob(k8s, MAIL_NAMESPACE, jobName, DEFAULT_TIMEOUT_MS, async (msg) => {
    await app.db.update(restoreItems)
      .set({ progressMessage: msg })
      .where(eq(restoreItems.id, item.id));
  });

  let log = '';
  // jmap-restore.py emits one JSON summary line per address to stdout.
  // The script's `echo "MAILBOX_RESTORED addr=$ADDR ..."` lines and
  // python stderr can interleave, so we don't require a fixed tail
  // length — grab the last 200 lines and JSON-parse any that look like
  // our summary shape.
  try { log = (await tailJobLog(k8s, MAIL_NAMESPACE, jobName, { tailLines: 200, maxLineLength: 5000 })) ?? ''; } catch { /* ignore */ }
  let imported = 0;
  let skippedTotal = 0;
  let failed = 0;
  let mailboxesCreated = 0;
  let prePurged = 0;
  let elapsedMs = 0;
  for (const line of log.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{') || !t.endsWith('}')) continue;
    try {
      const j = JSON.parse(t) as Partial<{
        imported: number;
        skipped: number;
        failed: number;
        prePurged: number;
        mailboxesCreated: string[];
        elapsedSeconds: number;
      }>;
      if (typeof j.imported === 'number') {
        imported += j.imported;
        skippedTotal += j.skipped ?? 0;
        failed += j.failed ?? 0;
        prePurged += j.prePurged ?? 0;
        mailboxesCreated += (j.mailboxesCreated ?? []).length;
        elapsedMs = Math.max(elapsedMs, Math.round((j.elapsedSeconds ?? 0) * 1000));
      }
    } catch {
      // Not a jmap-restore summary line; ignore.
    }
  }
  await app.db.update(restoreItems)
    .set({
      progressMessage:
        `restored ${addresses.length} mailbox(es) (mode=${mode}, imported=${imported}, ` +
        `skipped=${skippedTotal}, failed=${failed}, mailboxesCreated=${mailboxesCreated}, ` +
        `prePurged=${prePurged}, elapsedMs=${elapsedMs})`,
    })
    .where(eq(restoreItems.id, item.id));
}

export function buildMailboxesByAddressJobSpec(input: {
  jobName: string;
  mailNamespace: string;
  clientId: string;
  cartId: string;
  itemId: string;
  toolsImage: string;
  jmapEndpoint: string;
  stalwartMasterUser: string;
  masterSecretName: string;
  masterSecretKey: string;
  mode: MailboxRestoreMode;
  downloadBase: string;
  downloads: ReadonlyArray<{ address: string; token: string }>;
  workers: number;
}): Record<string, unknown> {
  for (const d of input.downloads) {
    if (!isSafeAddress(d.address)) {
      throw new Error(`buildMailboxesByAddressJobSpec: invalid address '${d.address}'`);
    }
  }
  if (!isSafeJmapEndpoint(input.jmapEndpoint)) {
    throw new Error(`buildMailboxesByAddressJobSpec: invalid jmapEndpoint '${input.jmapEndpoint}'`);
  }
  if (!isSafeMasterUser(input.stalwartMasterUser)) {
    throw new Error(`buildMailboxesByAddressJobSpec: invalid stalwartMasterUser '${input.stalwartMasterUser}'`);
  }
  if (!Number.isInteger(input.workers) || input.workers < 1 || input.workers > 64) {
    throw new Error(`buildMailboxesByAddressJobSpec: invalid workers '${input.workers}'`);
  }
  if (!VALID_MODES.has(input.mode)) {
    throw new Error(`buildMailboxesByAddressJobSpec: invalid mode '${input.mode}'`);
  }
  // Addresses + tokens are embedded directly in the script's `case "$i"`
  // dispatch block (see below) so we no longer need per-address env
  // vars. The master password is the only secret-mounted env.
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

  // Per-address loop. Each iteration:
  //   1. curl download .mbox.tar.gz → /tmp/maildir-tar/<addr>.tar.gz
  //   2. mkdir + tar -xzf into /tmp/maildir/<addr>/  (Maildir tree;
  //      jmap-restore.py expects <root>/<source-address>/<mailbox>/cur/...)
  //   3. python3 jmap-restore.py — Blob/upload + Email/import via the
  //      in-cluster JMAP mgmt endpoint, parallel uploads, mode-aware.
  //   4. rm -rf the per-address Maildir tree to free emptyDir for the
  //      next address (each tenant can have many addresses).
  //
  // Why `case "$i"` dispatch over `eval echo \$MAILBOX_ADDR_$i`:
  //   The eval indirection is a known shell-injection foot-gun. Even
  //   though isSafeAddress whitelists characters, the case-dispatch
  //   pattern is materially safer (no shell interpolation of the
  //   variable name itself) and matches the capture executor in
  //   tenant-bundles/components/mailboxes.ts. Build-time embedding
  //   uses the same whitelist the validator above already enforced.
  //
  // STALWART_MASTER_PASSWORD is read by jmap-restore.py via
  // --auth-pass-env (the password value never appears in argv,
  // keeping it out of /proc/<pid>/cmdline and `kubectl get pod -o yaml`).
  const caseBlock = input.downloads.map((d, i) =>
    `    ${i}) ADDR="${d.address}"; TOKEN="${d.token}";;`,
  ).join('\n');
  const script = [
    'set -e',
    `COUNT=${input.downloads.length}`,
    `MODE=${input.mode}`,
    `WORKERS=${input.workers}`,
    'mkdir -p /tmp/maildir-tar /tmp/maildir',
    'for i in $(seq 0 $((COUNT - 1))); do',
    '  ADDR=',
    '  TOKEN=',
    '  case "$i" in',
    caseBlock,
    '    *) echo "BUG: address index $i out of bounds" >&2; exit 1;;',
    '  esac',
    '  [ -n "$ADDR" ] || { echo "BUG: empty address at $i" >&2; exit 1; }',
    '  echo "Downloading $ADDR.mbox.tar.gz (#$i of $COUNT)..." >&2',
    `  curl --fail-with-body -sS -o "/tmp/maildir-tar/$ADDR.tar.gz" \\
       "${input.downloadBase}/$ADDR.mbox.tar.gz?token=$TOKEN"`,
    '  rm -rf "/tmp/maildir/$ADDR"',
    '  mkdir -p "/tmp/maildir/$ADDR"',
    '  tar -xzf "/tmp/maildir-tar/$ADDR.tar.gz" -C "/tmp/maildir/$ADDR"',
    '  rm -f "/tmp/maildir-tar/$ADDR.tar.gz"',
    '  echo "Restoring $ADDR via JMAP (mode=$MODE workers=$WORKERS)..." >&2',
    `  python3 /usr/local/bin/jmap-restore.py \\
       --endpoint "${input.jmapEndpoint}" \\
       --target-address "$ADDR" \\
       --source-address "$ADDR" \\
       --master-user "${input.stalwartMasterUser}" \\
       --auth-pass-env STALWART_MASTER_PASSWORD \\
       --maildir-root "/tmp/maildir/$ADDR" \\
       --mode "$MODE" \\
       --workers "$WORKERS"`,
    '  rm -rf "/tmp/maildir/$ADDR"',
    '  echo "MAILBOX_RESTORED addr=$ADDR mode=$MODE"',
    'done',
    'rmdir /tmp/maildir-tar /tmp/maildir 2>/dev/null || true',
    'echo "MAILBOXES_RESTORED total=$COUNT"',
  ].join('\n');

  return {
    metadata: {
      name: input.jobName,
      namespace: input.mailNamespace,
      labels: {
        // Reuse restore-files label so the existing NetworkPolicy
        // covers this Job too (it allows Job → platform-api +
        // Job → in-cluster Stalwart svc).
        'platform.io/component': 'restore-files',
        'platform.io/client-id': input.clientId,
        'platform.io/restore-cart': input.cartId,
        'platform.io/restore-item': input.itemId,
        'platform.io/sub-component': 'restore-mailboxes',
      },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: {
          labels: {
            'platform.io/component': 'restore-files',
            'platform.io/client-id': input.clientId,
            'platform.io/restore-cart': input.cartId,
            'platform.io/restore-item': input.itemId,
            'platform.io/sub-component': 'restore-mailboxes',
          },
        },
        spec: {
          restartPolicy: 'Never',
          containers: [{
            name: 'mailboxes-restore',
            image: input.toolsImage,
            // Same `Always` pull policy as the capture path
            // (tenant-bundles/components/mailboxes.ts) — keeps the
            // tag-floating `:latest` workflow honest until we pin
            // to a SHA via build-deploy. Worth ~50 ms of cold-start
            // image-list lookup per Job.
            imagePullPolicy: 'Always',
            command: ['sh', '-c', script],
            env: [
              masterPasswordEnv,
            ],
            resources: {
              // jmap-restore.py streams blobs one at a time through
              // urllib (no in-memory tarball buffer), so memory is
              // bounded by max-attachment-size × workers ≈ 1.6 GB at
              // the extreme. Limit set higher than peak to leave a
              // GC-time cushion.
              requests: { cpu: '200m', memory: '512Mi' },
              limits: { cpu: '2000m', memory: '2Gi' },
            },
            volumeMounts: [
              { name: 'scratch', mountPath: '/tmp' },
            ],
          }],
          volumes: [
            { name: 'scratch', emptyDir: { sizeLimit: '50Gi' } },
          ],
        },
      },
    },
  };
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
      throw new Error(`mailboxes-by-address Job ${jobName} failed: ${failed?.message ?? 'unknown'}`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`mailboxes-by-address Job ${jobName} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    if (onProgress) {
      const tail = await tailJobLog(k8s, namespace, jobName, { tailLines: 5, maxLineLength: 200 }).catch(() => null);
      await onProgress(tail ? `mailboxes-restore: ${tail}` : 'Restoring mailboxes…');
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
}
