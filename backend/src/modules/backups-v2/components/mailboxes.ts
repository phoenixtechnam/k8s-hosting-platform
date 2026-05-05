/**
 * `mailboxes` component capture (Phase 4 rewrite, 2026-05-05).
 *
 * Stalwart 0.16.3 dropped the per-account `stalwart-cli account export`
 * helper, so per-mailbox capture now goes through IMAP master-user
 * proxy auth (the same path Roundcube uses):
 *
 *   1. Resolve every mailbox address belonging to the client from
 *      the platform DB (mailboxes.full_address).
 *   2. Sign a per-mailbox HMAC upload token bound to
 *      (bundleId, 'mailboxes', '<address>.mbox.tar.gz').
 *   3. Spawn one Job in the `mail` namespace using the
 *      `mail-backup-tools` image (alpine + isync/mbsync + python3 +
 *      curl). The Job loops every address, calls
 *      `capture-mailbox.sh <addr> <upload-url>`, which:
 *         a. Writes a per-mailbox mbsync config that authenticates as
 *            `<addr>%<master>` with the master password (Stalwart
 *            master-user proxy mode — exactly the same syntax
 *            roundcube/jwt_auth.php uses).
 *         b. mbsync pulls the IMAP folders → /tmp/maildir (Maildir++).
 *         c. tar | gzip | tee >(sha256sum) | curl --upload-file streams
 *            the tarball straight to the platform-api internal upload
 *            endpoint — no intermediate file (Option F).
 *         d. rm -rf /tmp/maildir before the next address.
 *
 * Why master-user proxy and not per-mailbox auth:
 *   - Tenants don't share their per-mailbox passwords with the platform.
 *   - The webmail master account already holds `impersonate` rights on
 *     every mailbox in the cluster; the rotation flow is documented and
 *     audited (mail-admin/rotate-webmail-master.ts).
 *   - One Secret to manage instead of N tenant credentials.
 *
 * Failure modes:
 *   - mbsync exit ≠ 0 (one address) → set -e fails the Job; orchestrator
 *     marks component=failed. Phase 4.x can split per-address.
 *   - curl upload fails → same (loud failure).
 *   - Empty mailbox → mbsync writes an empty Maildir; tarball is small
 *     but valid; restore APPENDs zero messages.
 *
 * Ephemeral storage (Option F):
 *   The tarball never lands on disk — peak `/tmp` ≈ Maildir size only.
 *   For mailboxes >10 GiB the orchestrator can switch to per-folder
 *   streaming (a future helper script in mail-backup-tools); not
 *   required for v1 since `emptyDir.sizeLimit: 50Gi` covers the
 *   common case.
 */

import { sql } from 'drizzle-orm';
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import type { Database } from '../../../db/index.js';
import type { BackupStore, BundleHandle } from '../bundle-store.js';
import { tailJobLog } from '../../storage-lifecycle/job-log-tail.js';
import { signUploadToken } from '../upload-token.js';

export interface MailboxesComponentResult {
  readonly mailboxCount: number;
  readonly addresses: ReadonlyArray<string>;
  /** Total bytes across all mbox.tar.gz artefacts. */
  readonly sizeBytes: number;
}

export interface CaptureMailboxesComponentOpts {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly clientId: string;
  readonly backupId: string;
  readonly store: BackupStore;
  readonly handle: BundleHandle;
  readonly platformApiUrl: string;
  readonly secretsKeyHex: string;
  readonly mailNamespace?: string;       // defaults to 'mail'
  readonly imapServiceHost?: string;     // defaults to stalwart-mail-v016.mail.svc.cluster.local
  readonly imapServicePort?: number;     // defaults to 143 (STARTTLS)
  readonly stalwartMasterUser?: string;  // defaults to 'master'
  readonly masterSecretName?: string;    // defaults to 'roundcube-secrets'
  readonly masterSecretKey?: string;     // defaults to 'STALWART_MASTER_PASSWORD'
  readonly toolsImage?: string;          // defaults to ghcr.io/.../mail-backup-tools:latest
  readonly timeoutMs?: number;
  readonly onProgress?: (msg: string) => Promise<void> | void;
}

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const UPLOAD_TOKEN_TTL_SEC = 60 * 60;
const MAIL_NAMESPACE_DEFAULT = 'mail';
const IMAP_HOST_DEFAULT = 'stalwart-mail-v016.mail.svc.cluster.local';
const IMAP_PORT_DEFAULT = 143;
const MASTER_USER_DEFAULT = 'master';
const MASTER_SECRET_NAME_DEFAULT = 'roundcube-secrets';
const MASTER_SECRET_KEY_DEFAULT = 'STALWART_MASTER_PASSWORD';
const TOOLS_IMAGE_DEFAULT = 'ghcr.io/phoenixtechnam/hosting-platform/mail-backup-tools:latest';

export async function listClientMailboxAddresses(db: Database, clientId: string): Promise<string[]> {
  // The mailboxes table column is `full_address`, NOT `address`
  // (audited 2026-05-05 against staging DB schema).
  const rawDb = db as unknown as { execute: (q: ReturnType<typeof sql>) => Promise<{ rows: { full_address: string }[] }> };
  const r = await rawDb.execute(sql`SELECT full_address FROM mailboxes WHERE client_id = ${clientId} ORDER BY full_address`);
  return r.rows.map((row) => row.full_address);
}

function isSafeAddress(address: string): boolean {
  return /^[A-Za-z0-9._+\-]+@[A-Za-z0-9.\-]+$/.test(address);
}

// IMAP service host: DNS-name or in-cluster service name. No shell
// metacharacters allowed because the host is interpolated into the
// Job script body.
function isSafeImapHost(host: string): boolean {
  return /^[A-Za-z0-9.\-]+$/.test(host);
}

// Master user: alphanumeric + dot + underscore. Same justification
// as isSafeImapHost — value is interpolated into the script.
function isSafeMasterUser(user: string): boolean {
  return /^[A-Za-z0-9._\-]+$/.test(user);
}

/**
 * Build the K8s Job spec for the mailboxes-component capture.
 * Pure function — exposed for unit-testing the spec without a kube client.
 */
export function buildMailboxesComponentJobSpec(input: {
  jobName: string;
  mailNamespace: string;
  clientId: string;
  backupId: string;
  toolsImage: string;
  imapServiceHost: string;
  imapServicePort: number;
  stalwartMasterUser: string;
  masterSecretName: string;
  masterSecretKey: string;
  uploadBase: string;
  uploads: ReadonlyArray<{ address: string; token: string }>;
}): Record<string, unknown> {
  // Defence-in-depth: addresses come from the platform DB, but we
  // re-validate before composing the for-loop so a malformed address
  // can never break out of the script body.
  for (const u of input.uploads) {
    if (!isSafeAddress(u.address)) {
      throw new Error(`buildMailboxesComponentJobSpec: invalid address '${u.address}'`);
    }
  }
  if (!isSafeImapHost(input.imapServiceHost)) {
    throw new Error(`buildMailboxesComponentJobSpec: invalid imapServiceHost '${input.imapServiceHost}'`);
  }
  if (!Number.isInteger(input.imapServicePort) || input.imapServicePort < 1 || input.imapServicePort > 65535) {
    throw new Error(`buildMailboxesComponentJobSpec: invalid imapServicePort '${input.imapServicePort}'`);
  }
  if (!isSafeMasterUser(input.stalwartMasterUser)) {
    throw new Error(`buildMailboxesComponentJobSpec: invalid stalwartMasterUser '${input.stalwartMasterUser}'`);
  }

  const tokenEnvVars = input.uploads.map((u, i) => ({
    name: `MAILBOX_TOKEN_${i}`,
    value: u.token,
  }));
  const addressEnvVars = input.uploads.map((u, i) => ({
    name: `MAILBOX_ADDR_${i}`,
    value: u.address,
  }));

  // Master password from the Roundcube Secret. Same key used by
  // jwt_auth.php; rotation goes through rotateWebmailMasterPassword().
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

  // Loop body: capture-mailbox.sh handles mbsync + streaming upload.
  // We pass each address in via the env vars so the actual command
  // line stays generic and tokens never appear in `kubectl get pod`.
  const script = [
    'set -e',
    `COUNT=${input.uploads.length}`,
    'for i in $(seq 0 $((COUNT - 1))); do',
    '  ADDR_VAR="MAILBOX_ADDR_$i"',
    '  TOKEN_VAR="MAILBOX_TOKEN_$i"',
    '  ADDR=$(eval echo \\$$ADDR_VAR)',
    '  TOKEN=$(eval echo \\$$TOKEN_VAR)',
    '  echo "Capturing mailbox $ADDR (#$i) of $COUNT..." >&2',
    `  /usr/local/bin/capture-mailbox.sh "$ADDR" "${input.uploadBase}/$ADDR.mbox.tar.gz?token=$TOKEN"`,
    'done',
    'echo "MAILBOXES_TOTAL=$COUNT"',
  ].join('\n');

  return {
    metadata: {
      name: input.jobName,
      namespace: input.mailNamespace,
      labels: {
        // Reuse backup-files label so the existing NetworkPolicy that
        // allows Job→platform-api traffic also covers this Job.
        'platform.io/component': 'backup-files',
        'platform.io/client-id': input.clientId,
        'platform.io/backup-id': input.backupId,
        'platform.io/sub-component': 'backup-mailboxes',
      },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
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
          containers: [{
            name: 'mailboxes',
            image: input.toolsImage,
            imagePullPolicy: 'IfNotPresent',
            command: ['sh', '-c', script],
            env: [
              { name: 'IMAP_HOST', value: input.imapServiceHost },
              { name: 'IMAP_PORT', value: String(input.imapServicePort) },
              { name: 'STALWART_MASTER_USER', value: input.stalwartMasterUser },
              // The image's STARTTLS path will fail closed unless we
              // explicitly opt out of cert verification (in-cluster
              // service certificate is self-signed). MBSYNC_TLS_VERIFY=no
              // is the convention; production overlays can flip via
              // mail-backup-tools image config.
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
            // emptyDir holds Maildir for the in-flight mailbox.
            // sizeLimit covers Maildir-only (Option F: tarball never
            // lands on disk).
            { name: 'scratch', emptyDir: { sizeLimit: '50Gi' } },
          ],
        },
      },
    },
  };
}

export async function captureMailboxesComponent(
  opts: CaptureMailboxesComponentOpts,
): Promise<MailboxesComponentResult> {
  const addresses = await listClientMailboxAddresses(opts.db, opts.clientId);
  if (addresses.length === 0) {
    return { mailboxCount: 0, addresses: [], sizeBytes: 0 };
  }

  const uploads = addresses.map((address) => ({
    address,
    token: signUploadToken(
      { bundleId: opts.backupId, component: 'mailboxes', artifactName: `${address}.mbox.tar.gz`, ttlSeconds: UPLOAD_TOKEN_TTL_SEC },
      opts.secretsKeyHex,
    ),
  }));

  const mailNamespace = opts.mailNamespace ?? MAIL_NAMESPACE_DEFAULT;
  const uploadBase = `${opts.platformApiUrl.replace(/\/$/, '')}/api/v1/internal/bundles/${opts.backupId}/components/mailboxes`;
  const jobName = `bk-mbox-${opts.backupId}`.slice(0, 63);

  const spec = buildMailboxesComponentJobSpec({
    jobName,
    mailNamespace,
    clientId: opts.clientId,
    backupId: opts.backupId,
    toolsImage: opts.toolsImage ?? TOOLS_IMAGE_DEFAULT,
    imapServiceHost: opts.imapServiceHost ?? IMAP_HOST_DEFAULT,
    imapServicePort: opts.imapServicePort ?? IMAP_PORT_DEFAULT,
    stalwartMasterUser: opts.stalwartMasterUser ?? MASTER_USER_DEFAULT,
    masterSecretName: opts.masterSecretName ?? MASTER_SECRET_NAME_DEFAULT,
    masterSecretKey: opts.masterSecretKey ?? MASTER_SECRET_KEY_DEFAULT,
    uploadBase,
    uploads,
  });

  await (opts.k8s.batch as unknown as {
    createNamespacedJob: (a: { namespace: string; body: unknown }) => Promise<unknown>;
  }).createNamespacedJob({ namespace: mailNamespace, body: spec });

  await waitForJob(opts.k8s, mailNamespace, jobName, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.onProgress);

  const refs = await opts.store.listArtifacts(opts.handle, 'mailboxes');
  const sizeBytes = refs.reduce((s, r) => s + r.sizeBytes, 0);

  return {
    mailboxCount: addresses.length,
    addresses,
    sizeBytes,
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
