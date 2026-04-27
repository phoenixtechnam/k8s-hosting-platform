import * as k8s from '@kubernetes/client-node';

// The Kubernetes Secret Longhorn reads to build its S3 credentials. The
// name is hard-coded in the BackupTarget/default CR (see write path
// below), so changing it requires a coordinated change in both places.
const LONGHORN_SECRET_NAME = 'longhorn-backup-credentials';
const LONGHORN_NAMESPACE = 'longhorn-system';
const BACKUP_TARGET_NAME = 'default';
// A sibling copy lives in the platform namespace so the DR CronJobs
// (etcd snapshot, pg_dump, cluster-state, secrets-backup, hostpath-
// snapshot) can mount the same creds without crossing the longhorn-
// system boundary. Shape depends on TARGET_KIND:
//   TARGET_KIND=s3  → AWS_* + S3_* keys  (Longhorn + DR CronJobs share)
//   TARGET_KIND=ssh → SSH_* keys         (DR CronJobs only; Longhorn
//                                         BackupTarget CR is left inert)
const PLATFORM_SECRET_NAME = 'backup-credentials';
const PLATFORM_NAMESPACE = 'platform';

// All Secret-data keys the CronJobs read. Enumerated here so that
// switching target kinds (S3 ↔ SSH) leaves no stale fields behind —
// absent fields on a `replaceNamespacedSecret` call would otherwise
// retain their previous values.
const S3_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_ENDPOINTS',
  'VIRTUAL_HOSTED_STYLE',
  'S3_BUCKET',
  'S3_REGION',
  'S3_PATH_PREFIX',
] as const;

const SSH_KEYS = [
  'SSH_HOST',
  'SSH_PORT',
  'SSH_USER',
  'SSH_PATH',
  'SSH_PRIVATE_KEY',
] as const;

export interface S3BackupTargetInput {
  readonly kind: 's3';
  readonly endpoint: string;       // e.g. https://fsn1.your-objectstorage.com
  readonly region: string;          // e.g. eu-central
  readonly bucket: string;          // e.g. k8s-staging
  readonly accessKeyId: string;     // plaintext, handed to K8s Secret
  readonly secretAccessKey: string; // plaintext, handed to K8s Secret
  readonly pathPrefix?: string;     // optional, e.g. "longhorn-staging"
}

export interface SshBackupTargetInput {
  readonly kind: 'ssh';
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly path: string;
  readonly privateKey: string;      // plaintext PEM body, handed to K8s Secret
}

// Discriminated union: reconciler callers pass one of these, and the
// `kind` tag decides which branch of the Secret layout + Longhorn CR
// handling gets applied.
export type LonghornBackupTargetInput = S3BackupTargetInput | SshBackupTargetInput;

export interface LonghornClients {
  readonly core: k8s.CoreV1Api;
  readonly custom: k8s.CustomObjectsApi;
  // Optional: the BatchV1Api used to suspend/unsuspend the DR CronJobs
  // when an operator activates/deactivates a backup target. Made
  // optional so existing callers (and tests) that only stub core+custom
  // keep compiling — the reconciler skips the cron toggle when batch
  // is not provided and logs a warning.
  readonly batch?: k8s.BatchV1Api;
}

// CronJobs whose execution is meaningful only while a backup target is
// active. Most read the `backup-credentials` Secret directly (and would
// fail with CreateContainerConfigError without it); platform-backup-
// audit doesn't read the Secret but its audit (are PVCs in the backup
// group?) is pointless when no backup target is configured. Shipped
// with `suspend: true` in k8s/base/backup/*.yaml so a fresh install
// doesn't churn failed pods; the reconciler flips suspend on/off in
// lockstep with backup-target activation.
const BACKUP_CRONJOB_NAMES = [
  'platform-cluster-state-backup',
  'platform-etcd-snapshot-upload',
  'platform-pg-backup',
  'platform-secrets-backup',
  'platform-hostpath-snapshot-upload',
  'platform-backup-audit',
] as const;

/**
 * Create or update the credentials Secret(s) the cluster needs to run
 * backups, then (for S3 only) point Longhorn's BackupTarget/default at
 * that Secret. Called from the backup-config service when a row is
 * marked active, or when the active row's fields change.
 *
 * - S3 variant  → writes longhorn-system Secret + platform-ns Secret
 *                 + patches BackupTarget CR.
 * - SSH variant → writes ONLY the platform-ns Secret (Longhorn upstream
 *                 does not speak SSH; SSH is platform-level only for
 *                 our DR CronJobs).
 *
 * Idempotent: running it twice with the same input leaves the cluster
 * in the same state. An operator `kubectl edit`-ing the Secret or the
 * BackupTarget will be overwritten on next reconcile — that's intentional.
 * The admin panel is the source of truth.
 */
export async function reconcileBackupTarget(
  clients: LonghornClients,
  input: LonghornBackupTargetInput,
): Promise<void> {
  if (input.kind === 'ssh') {
    await upsertPlatformSecret(clients.core, buildSshSecretData(input));
    // Longhorn BackupTarget CR is intentionally left alone — SSH is
    // platform-level only. `clearBackupTarget({kind:'ssh'})` is the
    // reverse path and also a no-op on the CR.
    await setBackupCronJobsSuspended(clients.batch, false);
    return;
  }
  // S3 path — longhorn-system Secret mandatory (BackupTarget patch reads
  // from it), platform-ns copy is best-effort so DR CronJobs keep working
  // even if that namespace is misconfigured.
  const s3Secret = buildS3SecretData(input);
  await upsertNamespacedSecret(clients.core, LONGHORN_SECRET_NAME, LONGHORN_NAMESPACE, s3Secret);
  try {
    await upsertPlatformSecret(clients.core, s3Secret);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[longhorn-reconciler] Failed to sync platform backup-credentials:', err);
  }
  await upsertBackupTarget(clients.custom, input);
  await setBackupCronJobsSuspended(clients.batch, false);
}

/**
 * Clear the BackupTarget. Called when the only active config is
 * deactivated. For SSH, there's nothing on the CR to clear — the caller
 * still invokes this so a single de-activation codepath exists
 * regardless of target kind.
 *
 * The credentials Secret is kept so re-activating the same config
 * doesn't force a credential round-trip — delete-on-deactivate would
 * be an operator surprise if they intend to toggle the flag.
 */
export async function clearBackupTarget(
  clients: LonghornClients,
  opts: { readonly kind?: 's3' | 'ssh' } = {},
): Promise<void> {
  // Suspend DR CronJobs first so they stop trying to mount the
  // (still-present) credentials Secret while the BackupTarget CR is
  // being torn down. Idempotent — no-op when already suspended.
  await setBackupCronJobsSuspended(clients.batch, true);
  if (opts.kind === 'ssh') return;
  await patchBackupTarget(clients.custom, {
    spec: { backupTargetURL: '', credentialSecret: '' },
  });
}

/**
 * Toggle `spec.suspend` on every DR CronJob. Errors on individual
 * CronJobs are logged but not thrown — a missing CronJob (e.g. on a
 * partial install) shouldn't fail the whole activate/deactivate flow.
 */
async function setBackupCronJobsSuspended(
  batch: k8s.BatchV1Api | undefined,
  suspended: boolean,
): Promise<void> {
  if (!batch) {
    // eslint-disable-next-line no-console
    console.warn(
      '[longhorn-reconciler] BatchV1Api unavailable — DR CronJobs not toggled. ' +
      'They will remain in their current suspend state. Edit them with kubectl ' +
      'as a workaround.',
    );
    return;
  }
  for (const name of BACKUP_CRONJOB_NAMES) {
    try {
      await patchCronJobSuspend(batch, name, suspended);
    } catch (err) {
      if (isNotFound(err)) continue;
      // eslint-disable-next-line no-console
      console.warn(
        `[longhorn-reconciler] Failed to set suspend=${suspended} on ${name}:`,
        err,
      );
    }
  }
}

async function patchCronJobSuspend(
  batch: k8s.BatchV1Api,
  name: string,
  suspended: boolean,
): Promise<void> {
  // Strategic-merge-patch is what kubectl uses by default for built-in
  // resources. CronJob/BatchV1 supports it directly; no Content-Type
  // override needed (unlike the Longhorn BackupTarget CR which only
  // accepts merge-patch+json — see patchBackupTarget below).
  await batch.patchNamespacedCronJob(
    {
      name,
      namespace: PLATFORM_NAMESPACE,
      body: { spec: { suspend: suspended } },
    } as unknown as Parameters<typeof batch.patchNamespacedCronJob>[0],
  );
}

// Build the Secret data block for an S3 target. Explicit empty strings
// for SSH_* so switching SSH→S3 drops stale SSH keys on `replace`.
export function buildS3SecretData(input: S3BackupTargetInput): Record<string, string> {
  // Longhorn's reference docs list four keys (see
  // https://longhorn.io/docs/1.6.2/snapshots-and-backups/backup-and-restore/set-backup-target):
  //   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_ENDPOINTS /
  //   VIRTUAL_HOSTED_STYLE ("true" for AWS, empty for path-style providers
  //   like Hetzner/MinIO). We always send all four + S3_BUCKET/S3_REGION/
  //   S3_PATH_PREFIX (convenience for the aws-cli calls in DR CronJobs).
  const data: Record<string, string> = {
    TARGET_KIND: 's3',
    AWS_ACCESS_KEY_ID: input.accessKeyId,
    AWS_SECRET_ACCESS_KEY: input.secretAccessKey,
    AWS_ENDPOINTS: input.endpoint,
    VIRTUAL_HOSTED_STYLE: '',
    S3_BUCKET: input.bucket,
    S3_REGION: input.region,
    S3_PATH_PREFIX: input.pathPrefix ?? '',
  };
  for (const k of SSH_KEYS) data[k] = '';
  return data;
}

// Build the Secret data block for an SSH target. Explicit empty strings
// for AWS_*/S3_* so switching S3→SSH drops stale AWS keys on `replace`.
// SSH_PORT is written as a string because Kubernetes Secret values are
// always strings; the consumer scripts treat `${SSH_PORT:-22}` as a string.
export function buildSshSecretData(input: SshBackupTargetInput): Record<string, string> {
  const data: Record<string, string> = {
    TARGET_KIND: 'ssh',
    SSH_HOST: input.host,
    SSH_PORT: String(input.port),
    SSH_USER: input.user,
    SSH_PATH: input.path,
    SSH_PRIVATE_KEY: input.privateKey,
  };
  for (const k of S3_KEYS) data[k] = '';
  return data;
}

async function upsertPlatformSecret(
  core: k8s.CoreV1Api,
  stringData: Record<string, string>,
): Promise<void> {
  await upsertNamespacedSecret(core, PLATFORM_SECRET_NAME, PLATFORM_NAMESPACE, stringData);
}

async function upsertNamespacedSecret(
  core: k8s.CoreV1Api,
  secretName: string,
  secretNamespace: string,
  stringData: Record<string, string>,
): Promise<void> {
  // Base64 encoding is done by the @kubernetes client-node Secret API
  // when we pass `stringData`.
  const body: k8s.V1Secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: secretName,
      namespace: secretNamespace,
      labels: {
        'app.kubernetes.io/part-of': 'hosting-platform',
        'app.kubernetes.io/managed-by': 'platform-api',
      },
    },
    type: 'Opaque',
    stringData,
  };

  try {
    await core.replaceNamespacedSecret({
      name: secretName,
      namespace: secretNamespace,
      body,
    });
  } catch (err) {
    if (isNotFound(err)) {
      await core.createNamespacedSecret({ namespace: secretNamespace, body });
      return;
    }
    throw err;
  }
}

async function upsertBackupTarget(
  custom: k8s.CustomObjectsApi,
  input: S3BackupTargetInput,
): Promise<void> {
  // Longhorn parses backupTargetURL as `<scheme>://<bucket>@<region>/[<prefix>]`.
  // Scheme is `s3` for any S3-compatible provider; endpoint (discovered
  // via AWS_ENDPOINTS in the Secret) is what actually resolves to the
  // provider. The region token is required by Longhorn's parser even
  // when the provider itself is region-less (Hetzner, MinIO).
  const pathPart = input.pathPrefix
    ? `/${input.pathPrefix.replace(/^\/+|\/+$/g, '')}`
    : '/';
  const backupTargetURL = `s3://${input.bucket}@${input.region}${pathPart}`;

  await patchBackupTarget(custom, {
    spec: {
      backupTargetURL,
      credentialSecret: LONGHORN_SECRET_NAME,
    },
  });
}

async function patchBackupTarget(
  custom: k8s.CustomObjectsApi,
  patch: Record<string, unknown>,
): Promise<void> {
  // Longhorn BackupTarget accepts RFC 7396 merge-patch but NOT the
  // default JSON-patch the @kubernetes/client-node v1 library sends
  // (which expects [{op, path, value}] arrays). Without the explicit
  // Content-Type the apiserver rejects our object-shaped body with
  // "cannot unmarshal object into Go value of type []handlers.jsonPatchOp".
  //
  // v1.x library exposes a middleware hook on the second arg of every
  // API call. pre()/post() return an Observable (rxjsStub) — we wrap
  // our synchronous header override using the stub's `of(...)` helper.
  //
  // Using `as unknown as` cast because the library's exported
  // Middleware interface is internal to rxjsStub and types resist a
  // cleaner path without pulling rxjs in as a direct dep.
  const mergePatchOverride = {
    middleware: [
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pre: (ctx: any) => {
          ctx.setHeaderParam('Content-Type', 'application/merge-patch+json');
          // Observable<T> created from a resolved Promise — the library
          // internally awaits it, so the value lands immediately.
          return { toPromise: () => Promise.resolve(ctx), pipe: () => undefined };
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        post: (ctx: any) => ({ toPromise: () => Promise.resolve(ctx), pipe: () => undefined }),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  try {
    await custom.patchClusterCustomObject(
      {
        group: 'longhorn.io',
        version: 'v1beta2',
        plural: 'backuptargets',
        name: BACKUP_TARGET_NAME,
        body: patch,
      } as unknown as Parameters<typeof custom.patchClusterCustomObject>[0],
      mergePatchOverride,
    );
  } catch (err) {
    // Older Longhorn installs scope BackupTargets to longhorn-system
    // as namespaced resources. Fall through on 404 and retry with the
    // namespaced API — keeps the reconciler version-agnostic.
    if (isNotFound(err)) {
      await custom.patchNamespacedCustomObject(
        {
          group: 'longhorn.io',
          version: 'v1beta2',
          namespace: LONGHORN_NAMESPACE,
          plural: 'backuptargets',
          name: BACKUP_TARGET_NAME,
          body: patch,
        } as unknown as Parameters<typeof custom.patchNamespacedCustomObject>[0],
        mergePatchOverride,
      );
      return;
    }
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as {
    statusCode?: number;
    status?: number;
    code?: number;
    body?: unknown;
    message?: string;
  };
  if (e.statusCode === 404 || e.status === 404 || e.code === 404) return true;
  // @kubernetes/client-node v1 wraps API errors in a generic Error whose
  // message begins with "HTTP-Code: 404 Message: Unknown API Status
  // Code! Body: <json-string>". Neither .statusCode nor .code is set on
  // the outer object — the only machine-readable signal is the message
  // prefix and the stringified body.
  if (typeof e.message === 'string' && /HTTP-Code:\s*404\b/.test(e.message)) return true;
  if (typeof e.body === 'object' && e.body !== null) {
    const b = e.body as { code?: number; reason?: string };
    if (b.code === 404 || b.reason === 'NotFound') return true;
  }
  if (typeof e.body === 'string') {
    try {
      const parsed = JSON.parse(e.body) as { code?: number; reason?: string };
      if (parsed.code === 404 || parsed.reason === 'NotFound') return true;
    } catch { /* body wasn't JSON; ignore */ }
  }
  return false;
}
