/**
 * Restore executor: `mailboxes-by-address`.
 *
 * Mirror of the Phase-3 mailboxes capture: spawns a Job in the `mail`
 * namespace using the Stalwart image (which ships stalwart-cli),
 * downloads each per-mailbox tarball from platform-api's internal-
 * download endpoint, and runs `stalwart-cli account import` per
 * address.
 *
 * Selector shapes (per api-contracts/restore.ts):
 *   { kind: 'all' }                                      — restore every mailbox in bundle
 *   { kind: 'addresses', addresses: ['a@x.com', …] }
 *
 * Per-mailbox HMAC tokens (one per artefact name) are passed via env
 * vars not script body, matching the capture pattern.
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { BackupStore } from '../../backups-v2/bundle-store.js';
import { restoreItems, restoreJobs, type RestoreItem } from '../../../db/schema.js';
import { ApiError } from '../../../shared/errors.js';
import { signUploadToken } from '../../backups-v2/upload-token.js';
import { tailJobLog } from '../../storage-lifecycle/job-log-tail.js';
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';

interface Selector {
  kind: 'all' | 'addresses';
  addresses?: readonly string[];
}

const MAIL_NAMESPACE = 'mail';
const STALWART_MGMT_URL_DEFAULT = 'http://stalwart-mail-v016.mail.svc.cluster.local:8080';
const STALWART_IMAGE_DEFAULT = 'docker.io/stalwartlabs/stalwart:v0.16.3';
const DOWNLOAD_TOKEN_TTL_SEC = 30 * 60;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function isSafeAddress(address: string): boolean {
  return /^[A-Za-z0-9._+\-]+@[A-Za-z0-9.\-]+$/.test(address);
}

export async function execMailboxesByAddressItem(args: {
  app: FastifyInstance;
  item: RestoreItem;
  store: BackupStore;
}): Promise<void> {
  const { app, item, store } = args;
  const selector = item.selector as unknown as Selector;

  // Resolve the cart's client (cross-tenant guard via restoreJobs).
  const [job] = await app.db.select().from(restoreJobs).where(eq(restoreJobs.id, item.restoreJobId)).limit(1);
  if (!job) throw new ApiError('NOT_FOUND', `Restore job ${item.restoreJobId} not found`, 404);

  // Determine which addresses to restore. For 'all', we list the
  // bundle's mailboxes component to discover what was captured.
  let addresses: readonly string[];
  if (selector.kind === 'all') {
    const handle = await store.open(item.bundleId);
    if (!handle) throw new ApiError('NOT_FOUND', `Bundle ${item.bundleId} not found on remote target`, 404);
    const refs = await store.listArtifacts(handle, 'mailboxes');
    addresses = refs.map((r) => r.name.replace(/\.mbox\.tar\.gz$/, '')).filter((s) => s.length > 0);
    if (addresses.length === 0) {
      // Bundle has no mailboxes component or it's empty — nothing
      // to do. Treat as success.
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
  const secretsKeyHex = (app.config as Record<string, unknown>).OIDC_ENCRYPTION_KEY as string | undefined
    ?? process.env.OIDC_ENCRYPTION_KEY
    ?? '0'.repeat(64);

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
    jobImage: STALWART_IMAGE_DEFAULT,
    stalwartMgmtUrl: STALWART_MGMT_URL_DEFAULT,
    downloadBase,
    downloads,
  });

  const k8s = (app as unknown as { k8s: K8sClients }).k8s;
  if (!k8s) throw new Error('mailboxes-by-address: k8s client not available on app');
  await (k8s.batch as unknown as {
    createNamespacedJob: (a: { namespace: string; body: unknown }) => Promise<unknown>;
  }).createNamespacedJob({ namespace: MAIL_NAMESPACE, body: spec });

  await waitForJob(k8s, MAIL_NAMESPACE, jobName, DEFAULT_TIMEOUT_MS, async (msg) => {
    await app.db.update(restoreItems)
      .set({ progressMessage: msg })
      .where(eq(restoreItems.id, item.id));
  });

  let log = '';
  try { log = (await tailJobLog(k8s, MAIL_NAMESPACE, jobName, { tailLines: 30, maxLineLength: 5000 })) ?? ''; } catch { /* ignore */ }
  const restored = (log.match(/MAILBOXES_RESTORED total=(\d+)/) ?? [])[1] ?? `${addresses.length}`;
  await app.db.update(restoreItems)
    .set({ progressMessage: `restored ${restored}/${addresses.length} mailbox(es)` })
    .where(eq(restoreItems.id, item.id));
}

export function buildMailboxesByAddressJobSpec(input: {
  jobName: string;
  mailNamespace: string;
  clientId: string;
  cartId: string;
  itemId: string;
  jobImage: string;
  stalwartMgmtUrl: string;
  downloadBase: string;
  downloads: ReadonlyArray<{ address: string; token: string }>;
}): Record<string, unknown> {
  for (const d of input.downloads) {
    if (!isSafeAddress(d.address)) {
      throw new Error(`buildMailboxesByAddressJobSpec: invalid address '${d.address}'`);
    }
  }
  const tokenEnvVars = input.downloads.map((d, i) => ({
    name: `MAILBOX_TOKEN_${i}`,
    value: d.token,
  }));
  const addressEnvVars = input.downloads.map((d, i) => ({
    name: `MAILBOX_ADDR_${i}`,
    value: d.address,
  }));
  const stalwartCredsEnv = [
    {
      name: 'STALWART_RECOVERY_ADMIN',
      valueFrom: {
        secretKeyRef: {
          name: 'stalwart-admin-creds',
          key: 'recoveryAdmin',
          optional: false,
        },
      },
    },
  ];
  const script = [
    'set -e',
    'command -v curl >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq curl) >/dev/null 2>&1 || { echo "ERROR: curl install failed"; exit 1; }',
    'command -v stalwart-cli >/dev/null 2>&1 || { echo "ERROR: stalwart-cli not on PATH"; exit 1; }',
    'COUNT=' + input.downloads.length,
    'mkdir -p /tmp/mboxes',
    'RESTORED=0',
    'for i in $(seq 0 $((COUNT - 1))); do',
    '  ADDR_VAR="MAILBOX_ADDR_$i"',
    '  TOKEN_VAR="MAILBOX_TOKEN_$i"',
    '  ADDR=$(eval echo \\$$ADDR_VAR)',
    '  TOKEN=$(eval echo \\$$TOKEN_VAR)',
    '  echo "Downloading $ADDR.mbox.tar.gz..."',
    `  curl --fail-with-body -sS -o "/tmp/mboxes/$ADDR.tar.gz" \\
       "${input.downloadBase}/$ADDR.mbox.tar.gz?token=$TOKEN"`,
    '  echo "Importing $ADDR via stalwart-cli..."',
    `  stalwart-cli -u "${input.stalwartMgmtUrl}" -c "$STALWART_RECOVERY_ADMIN" \\
       account import "$ADDR" "/tmp/mboxes/$ADDR.tar.gz"`,
    '  rm -f "/tmp/mboxes/$ADDR.tar.gz"',
    '  RESTORED=$((RESTORED + 1))',
    '  echo "MAILBOX_RESTORED addr=$ADDR (#$RESTORED of $COUNT)"',
    'done',
    'echo "MAILBOXES_RESTORED total=$RESTORED"',
  ].join('\n');
  return {
    metadata: {
      name: input.jobName,
      namespace: input.mailNamespace,
      labels: {
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
            image: input.jobImage,
            imagePullPolicy: 'IfNotPresent',
            command: ['sh', '-c', script],
            env: [...stalwartCredsEnv, ...addressEnvVars, ...tokenEnvVars],
            resources: {
              requests: { cpu: '100m', memory: '128Mi' },
              limits: { cpu: '500m', memory: '512Mi' },
            },
          }],
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
