/**
 * Restore executor: `mailboxes-by-address` (Phase 4 rewrite, 2026-05-05).
 *
 * Stalwart 0.16.3 dropped per-account `stalwart-cli` import. Restore
 * now goes through IMAP master-user proxy auth (the same path the
 * capture executor uses):
 *
 *   1. For 'addresses' selector: validate addresses + sanitise.
 *      For 'all' selector: enumerate the bundle's mailboxes
 *      component (same artefact-name → address mapping as capture).
 *   2. Sign one HMAC download token per address.
 *   3. Spawn a Job in the `mail` namespace using mail-backup-tools.
 *      For each address the Job:
 *        a. curl downloads `<addr>.mbox.tar.gz` to /tmp.
 *        b. tar -xzf into /tmp/maildir/<addr>/.
 *        c. python3 /usr/local/bin/restore-mailbox.py
 *             $IMAP_HOST $IMAP_PORT "<addr>%<master>" $MASTER_PW $MODE /tmp/maildir/<addr>
 *        d. rm -rf the maildir before the next address.
 *
 * Mode plumbing:
 *   The restore mode lives in the selector (mailboxRestoreModeSchema):
 *     - merge-skip-duplicates (default)
 *     - merge-overwrite
 *     - replace                        (requires confirmDestructive: true)
 *   The schema's superRefine enforces the typed-confirmation pattern;
 *   the executor reads selector.mode (defaulting to merge-skip).
 *
 * Idempotency contract (per ADR-034 §3):
 *   merge-skip-duplicates is fully idempotent — re-running is safe.
 *   merge-overwrite is monotonic (each run appends without dedup).
 *   replace is destructive but crash-safe (RENAME-then-APPEND).
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { BackupStore } from '../../backups-v2/bundle-store.js';
import { restoreItems, restoreJobs, type RestoreItem } from '../../../db/schema.js';
import { ApiError } from '../../../shared/errors.js';
import { signUploadToken } from '../../backups-v2/upload-token.js';
import { tailJobLog } from '../../storage-lifecycle/job-log-tail.js';
import { createK8sClients, type K8sClients } from '../../k8s-provisioner/k8s-client.js';
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
const IMAP_HOST_DEFAULT = 'stalwart-mail-v016.mail.svc.cluster.local';
const IMAP_PORT_DEFAULT = 993;
const MASTER_USER_DEFAULT = 'master';
const MASTER_SECRET_NAME_DEFAULT = 'roundcube-secrets';
const MASTER_SECRET_KEY_DEFAULT = 'STALWART_MASTER_PASSWORD';
const TOOLS_IMAGE_DEFAULT = 'ghcr.io/phoenixtechnam/hosting-platform/mail-backup-tools:latest';
const DOWNLOAD_TOKEN_TTL_SEC = 60 * 60;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

const VALID_MODES: ReadonlySet<MailboxRestoreMode> = new Set([
  'merge-skip-duplicates',
  'merge-overwrite',
  'replace',
]);

function isSafeAddress(address: string): boolean {
  return /^[A-Za-z0-9._+\-]+@[A-Za-z0-9.\-]+$/.test(address);
}

function isSafeImapHost(host: string): boolean {
  return /^[A-Za-z0-9.\-]+$/.test(host);
}

function isSafeMasterUser(user: string): boolean {
  return /^[A-Za-z0-9._\-]+$/.test(user);
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
  const configuredKey = (app.config as Record<string, unknown>).OIDC_ENCRYPTION_KEY as string | undefined
    ?? process.env.OIDC_ENCRYPTION_KEY;
  if (!configuredKey) {
    app.log.error(
      { module: 'mailboxes-by-address-restore' },
      'OIDC_ENCRYPTION_KEY missing — falling back to a zero-key. HMAC tokens for download URLs will be predictable; restore will only succeed if capture-side ran with the same fallback.',
    );
  }
  const secretsKeyHex = configuredKey ?? '0'.repeat(64);

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
    imapServiceHost: IMAP_HOST_DEFAULT,
    imapServicePort: IMAP_PORT_DEFAULT,
    stalwartMasterUser: MASTER_USER_DEFAULT,
    masterSecretName: MASTER_SECRET_NAME_DEFAULT,
    masterSecretKey: MASTER_SECRET_KEY_DEFAULT,
    mode,
    downloadBase,
    downloads,
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
  try { log = (await tailJobLog(k8s, MAIL_NAMESPACE, jobName, { tailLines: 80, maxLineLength: 5000 })) ?? ''; } catch { /* ignore */ }
  // Aggregate per-mailbox `RESULT mode=… folders=… appended=N skipped=M` lines.
  let appended = 0, skipped = 0, folders = 0;
  for (const m of log.matchAll(/RESULT mode=\S+ folders=(\d+) appended=(\d+) skipped=(\d+)/g)) {
    folders += Number(m[1]);
    appended += Number(m[2]);
    skipped += Number(m[3]);
  }
  await app.db.update(restoreItems)
    .set({
      progressMessage:
        `restored ${addresses.length} mailbox(es) (mode=${mode}, folders=${folders}, appended=${appended}, skipped=${skipped})`,
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
  imapServiceHost: string;
  imapServicePort: number;
  stalwartMasterUser: string;
  masterSecretName: string;
  masterSecretKey: string;
  mode: MailboxRestoreMode;
  downloadBase: string;
  downloads: ReadonlyArray<{ address: string; token: string }>;
}): Record<string, unknown> {
  for (const d of input.downloads) {
    if (!isSafeAddress(d.address)) {
      throw new Error(`buildMailboxesByAddressJobSpec: invalid address '${d.address}'`);
    }
  }
  if (!isSafeImapHost(input.imapServiceHost)) {
    throw new Error(`buildMailboxesByAddressJobSpec: invalid imapServiceHost '${input.imapServiceHost}'`);
  }
  if (!Number.isInteger(input.imapServicePort) || input.imapServicePort < 1 || input.imapServicePort > 65535) {
    throw new Error(`buildMailboxesByAddressJobSpec: invalid imapServicePort '${input.imapServicePort}'`);
  }
  if (!isSafeMasterUser(input.stalwartMasterUser)) {
    throw new Error(`buildMailboxesByAddressJobSpec: invalid stalwartMasterUser '${input.stalwartMasterUser}'`);
  }
  if (!VALID_MODES.has(input.mode)) {
    throw new Error(`buildMailboxesByAddressJobSpec: invalid mode '${input.mode}'`);
  }
  const tokenEnvVars = input.downloads.map((d, i) => ({
    name: `MAILBOX_TOKEN_${i}`,
    value: d.token,
  }));
  const addressEnvVars = input.downloads.map((d, i) => ({
    name: `MAILBOX_ADDR_${i}`,
    value: d.address,
  }));
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
  //   1. curl download .mbox.tar.gz → /tmp/maildir/<addr>.tar.gz
  //   2. mkdir + tar -xzf (the tarball is a streamed `tar -cf - .` over
  //      a Maildir root, so its top-level entries are `./cur`, `./new`,
  //      `./.Sent/`, …)
  //   3. python3 restore-mailbox.py with the chosen mode.
  //   4. rm -rf the maildir to free emptyDir for the next address.
  //
  // The IMAP master-user proxy username is `<addr>%<master>`; the
  // password comes from the env-injected Secret. We pass it on the
  // CLI for restore-mailbox.py — it's only visible inside the Job's
  // own pod (kubectl get pod -o yaml redacts container env values
  // sourced from secretKeyRef, but command/args are visible to anyone
  // with `pods` get-perms in the mail namespace; that audience is
  // already trusted). Acceptable trade-off; revisit if/when we ship
  // a multi-tenant audit role.
  const script = [
    'set -e',
    `COUNT=${input.downloads.length}`,
    `MODE=${input.mode}`,
    'mkdir -p /tmp/maildir',
    'for i in $(seq 0 $((COUNT - 1))); do',
    '  ADDR_VAR="MAILBOX_ADDR_$i"',
    '  TOKEN_VAR="MAILBOX_TOKEN_$i"',
    '  ADDR=$(eval echo \\$$ADDR_VAR)',
    '  TOKEN=$(eval echo \\$$TOKEN_VAR)',
    '  echo "Downloading $ADDR.mbox.tar.gz (#$i of $COUNT)..." >&2',
    `  curl --fail-with-body -sS -o "/tmp/maildir/$ADDR.tar.gz" \\
       "${input.downloadBase}/$ADDR.mbox.tar.gz?token=$TOKEN"`,
    '  rm -rf "/tmp/maildir/$ADDR"',
    '  mkdir -p "/tmp/maildir/$ADDR"',
    '  tar -xzf "/tmp/maildir/$ADDR.tar.gz" -C "/tmp/maildir/$ADDR"',
    '  rm -f "/tmp/maildir/$ADDR.tar.gz"',
    '  echo "Restoring $ADDR via IMAP master-user proxy (mode=$MODE)..." >&2',
    `  python3 /usr/local/bin/restore-mailbox.py \\
       "${input.imapServiceHost}" "${input.imapServicePort}" \\
       "$ADDR%${input.stalwartMasterUser}" "$STALWART_MASTER_PASSWORD" \\
       "$MODE" "/tmp/maildir/$ADDR"`,
    '  rm -rf "/tmp/maildir/$ADDR"',
    '  echo "MAILBOX_RESTORED addr=$ADDR mode=$MODE"',
    'done',
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
            imagePullPolicy: 'IfNotPresent',
            command: ['sh', '-c', script],
            env: [
              { name: 'MBSYNC_TLS_VERIFY', value: 'no' },
              masterPasswordEnv,
              ...addressEnvVars,
              ...tokenEnvVars,
            ],
            resources: {
              requests: { cpu: '100m', memory: '256Mi' },
              limits: { cpu: '1000m', memory: '1Gi' },
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
