import * as k8s from '@kubernetes/client-node';

// The Kubernetes Secret Longhorn reads to build its S3 credentials. The
// name is hard-coded in the BackupTarget/default CR (see write path
// below), so changing it requires a coordinated change in both places.
const LONGHORN_SECRET_NAME = 'longhorn-backup-credentials';
const LONGHORN_NAMESPACE = 'longhorn-system';
const BACKUP_TARGET_NAME = 'default';

export interface LonghornBackupTargetInput {
  readonly endpoint: string;       // e.g. https://fsn1.your-objectstorage.com
  readonly region: string;          // e.g. eu-central
  readonly bucket: string;          // e.g. k8s-staging
  readonly accessKeyId: string;     // plaintext, handed to K8s Secret
  readonly secretAccessKey: string; // plaintext, handed to K8s Secret
  readonly pathPrefix?: string;     // optional, e.g. "longhorn-staging"
}

export interface LonghornClients {
  readonly core: k8s.CoreV1Api;
  readonly custom: k8s.CustomObjectsApi;
}

/**
 * Create or update the Secret that Longhorn uses to authenticate with
 * the S3 backup target, then point BackupTarget/default at it. Called
 * from the backup-config service when a row is marked active (or when
 * the active row's S3 fields change).
 *
 * Idempotent: running it twice with the same input leaves the cluster
 * in the same state. An operator `kubectl edit`-ing either resource
 * will be overwritten on next reconcile — that's intentional. The
 * admin panel is the source of truth.
 */
export async function reconcileBackupTarget(
  clients: LonghornClients,
  input: LonghornBackupTargetInput,
): Promise<void> {
  await upsertCredentialsSecret(clients.core, input);
  await upsertBackupTarget(clients.custom, input);
}

/**
 * Clear the BackupTarget. Called when the only active config is
 * deactivated. The Secret is kept so re-activating the same config
 * doesn't force a credential round-trip — delete-on-deactivate would
 * be an operator surprise if they intend to toggle the flag.
 */
export async function clearBackupTarget(clients: LonghornClients): Promise<void> {
  await patchBackupTarget(clients.custom, {
    spec: { backupTargetURL: '', credentialSecret: '' },
  });
}

async function upsertCredentialsSecret(
  core: k8s.CoreV1Api,
  input: LonghornBackupTargetInput,
): Promise<void> {
  // Longhorn's reference docs list four keys (see
  // https://longhorn.io/docs/1.6.2/snapshots-and-backups/backup-and-restore/set-backup-target):
  //   AWS_ACCESS_KEY_ID
  //   AWS_SECRET_ACCESS_KEY
  //   AWS_ENDPOINTS       (non-AWS providers — scheme://host)
  //   VIRTUAL_HOSTED_STYLE (set to "true" for AWS, leave empty for
  //                        path-style providers like Hetzner/MinIO)
  //
  // We always send all four so switching from Hetzner to AWS doesn't
  // leave stale keys behind. Base64 encoding is done by the @kubernetes
  // client-node Secret API when we pass `stringData`.
  const body: k8s.V1Secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: LONGHORN_SECRET_NAME,
      namespace: LONGHORN_NAMESPACE,
      labels: {
        'app.kubernetes.io/part-of': 'hosting-platform',
        'app.kubernetes.io/managed-by': 'platform-api',
      },
    },
    type: 'Opaque',
    stringData: {
      AWS_ACCESS_KEY_ID: input.accessKeyId,
      AWS_SECRET_ACCESS_KEY: input.secretAccessKey,
      AWS_ENDPOINTS: input.endpoint,
      VIRTUAL_HOSTED_STYLE: '',
    },
  };

  try {
    await core.replaceNamespacedSecret({
      name: LONGHORN_SECRET_NAME,
      namespace: LONGHORN_NAMESPACE,
      body,
    });
  } catch (err) {
    if (isNotFound(err)) {
      await core.createNamespacedSecret({ namespace: LONGHORN_NAMESPACE, body });
      return;
    }
    throw err;
  }
}

async function upsertBackupTarget(
  custom: k8s.CustomObjectsApi,
  input: LonghornBackupTargetInput,
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
  try {
    await custom.patchClusterCustomObject({
      group: 'longhorn.io',
      version: 'v1beta2',
      plural: 'backuptargets',
      name: BACKUP_TARGET_NAME,
      body: patch,
    } as unknown as Parameters<typeof custom.patchClusterCustomObject>[0]);
  } catch (err) {
    // Older Longhorn installs scope BackupTargets to longhorn-system
    // as namespaced resources. Fall through on 404 and retry with the
    // namespaced API — keeps the reconciler version-agnostic.
    if (isNotFound(err)) {
      await custom.patchNamespacedCustomObject({
        group: 'longhorn.io',
        version: 'v1beta2',
        namespace: LONGHORN_NAMESPACE,
        plural: 'backuptargets',
        name: BACKUP_TARGET_NAME,
        body: patch,
      } as unknown as Parameters<typeof custom.patchNamespacedCustomObject>[0]);
      return;
    }
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { statusCode?: number; status?: number; body?: { code?: number } };
  return e.statusCode === 404 || e.status === 404 || e.body?.code === 404;
}
