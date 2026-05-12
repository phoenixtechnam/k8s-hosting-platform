// Per-deployment image-pull credential storage + materialisation.
//
// The PAT cleartext exists for exactly two moments in the request
// lifetime:
//   1. POST/PUT body — the tenant submits it.
//   2. Service-side renderer — we build the dockerconfigjson, write
//      the k8s Secret, and forget the cleartext.
//
// At rest the token is AES-256-GCM-encrypted with OIDC_ENCRYPTION_KEY
// (same envelope shape as oidc/crypto.ts and mtls-providers). It is
// NEVER returned by the API — `pullCredentialResponseSchema` exposes
// only `tokenLastFour` plus the non-secret fields. Wherever this
// module errors we use the `redact()` helper so a stray `console.log`
// or thrown ApiError doesn't leak the token through logs.
//
// k8s Secret naming: `image-pull-{deploymentId}`, kubernetes.io/
// dockerconfigjson type. The Secret lives in the tenant namespace and
// is referenced via `imagePullSecrets` on the Pod template.

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { customDeploymentImageCredentials } from '../../db/schema.js';
import { encrypt, decrypt } from '../oidc/crypto.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { STRATEGIC_MERGE_PATCH } from '../../shared/k8s-patch.js';
import { ApiError } from '../../shared/errors.js';

export interface PatSubmission {
  readonly registryHost: string;
  readonly username: string;
  readonly token: string;
}

export interface PullCredentialRecord {
  readonly id: string;
  readonly deploymentId: string;
  readonly registryHost: string;
  readonly username: string;
  readonly tokenLastFour: string;
  readonly createdAt: Date;
  readonly rotatedAt: Date | null;
}

/**
 * Redact a token to its last 4 chars, masking everything else as `*`.
 * Used in error messages and audit logs so a leaked stack trace does
 * not echo the cleartext.
 */
export function redact(token: string): string {
  if (token.length <= 4) return '*'.repeat(token.length);
  return '*'.repeat(token.length - 4) + token.slice(-4);
}

/**
 * Build a docker dockerconfigjson body for a single registry.
 * Spec: https://kubernetes.io/docs/tasks/configure-pod-container/pull-image-private-registry/
 *
 * `auths.<registry>.auth` is the base64 of `username:token`. The optional
 * `auths.<registry>.email` field is omitted — Docker hub used to require
 * it but modern registries ignore it.
 */
function buildDockerConfigJson(submission: PatSubmission): string {
  const auth = Buffer.from(`${submission.username}:${submission.token}`, 'utf8').toString('base64');
  const body = {
    auths: {
      [submission.registryHost]: {
        username: submission.username,
        // Password is the PAT here — same field, dockerconfigjson
        // doesn't have a separate "token" key.
        password: submission.token,
        auth,
      },
    },
  };
  return JSON.stringify(body);
}

export function k8sPullSecretName(deploymentId: string): string {
  return `image-pull-${deploymentId}`;
}

// ─── Persistence (DB) ───────────────────────────────────────────────────────

/**
 * Upsert a PAT for a deployment. The DB unique index on
 * `deployment_id` enforces one credential per deployment in Phase 1;
 * an existing record is overwritten with the new token + bumped
 * rotated_at.
 */
export async function upsertPullCredential(
  db: Database,
  deploymentId: string,
  submission: PatSubmission,
  encryptionKey: string,
): Promise<PullCredentialRecord> {
  if (!encryptionKey) {
    throw new ApiError(
      'ENCRYPTION_KEY_MISSING',
      'Cannot store image pull credentials without an encryption key.',
      500,
    );
  }
  const tokenLastFour = submission.token.length >= 4
    ? submission.token.slice(-4)
    : submission.token.padStart(4, '*');

  // Encrypt LAST so the cleartext lifetime in this function is as
  // short as possible and no later branch (e.g. an error in the DB
  // path) sees the cleartext.
  const tokenCipher = encrypt(submission.token, encryptionKey);

  // Upsert by (deploymentId) — there's a UNIQUE index, so a second
  // submission for the same deployment rotates rather than inserts.
  const existing = await db.select()
    .from(customDeploymentImageCredentials)
    .where(eq(customDeploymentImageCredentials.deploymentId, deploymentId));

  if (existing.length > 0) {
    const [row] = await db.update(customDeploymentImageCredentials)
      .set({
        registryHost: submission.registryHost,
        username: submission.username,
        tokenCipher,
        tokenLastFour,
        rotatedAt: new Date(),
      })
      .where(eq(customDeploymentImageCredentials.deploymentId, deploymentId))
      .returning();
    return rowToRecord(row);
  }

  const id = randomUUID();
  const [row] = await db.insert(customDeploymentImageCredentials)
    .values({
      id,
      deploymentId,
      registryHost: submission.registryHost,
      username: submission.username,
      tokenCipher,
      tokenLastFour,
    })
    .returning();
  return rowToRecord(row);
}

export async function getPullCredential(
  db: Database,
  deploymentId: string,
): Promise<PullCredentialRecord | null> {
  const [row] = await db.select()
    .from(customDeploymentImageCredentials)
    .where(eq(customDeploymentImageCredentials.deploymentId, deploymentId));
  return row ? rowToRecord(row) : null;
}

export async function getPullCredentialById(
  db: Database,
  id: string,
): Promise<PullCredentialRecord | null> {
  const [row] = await db.select()
    .from(customDeploymentImageCredentials)
    .where(eq(customDeploymentImageCredentials.id, id));
  return row ? rowToRecord(row) : null;
}

export async function deletePullCredential(
  db: Database,
  deploymentId: string,
): Promise<boolean> {
  const result = await db.delete(customDeploymentImageCredentials)
    .where(eq(customDeploymentImageCredentials.deploymentId, deploymentId))
    .returning();
  return result.length > 0;
}

/**
 * Resolve the credential cleartext for materialisation. ONLY the
 * service layer should call this; the cleartext exists in memory for
 * the duration of the k8s Secret apply and is then dropped.
 */
export async function loadDecryptedToken(
  db: Database,
  deploymentId: string,
  encryptionKey: string,
): Promise<{ registryHost: string; username: string; token: string } | null> {
  const [row] = await db.select()
    .from(customDeploymentImageCredentials)
    .where(eq(customDeploymentImageCredentials.deploymentId, deploymentId));
  if (!row) return null;
  try {
    const token = decrypt(row.tokenCipher, encryptionKey);
    return {
      registryHost: row.registryHost,
      username: row.username,
      token,
    };
  } catch {
    // Decryption failure: stale key, bad ciphertext, etc. Surface a
    // crisp error WITHOUT echoing the ciphertext. The original error
    // is intentionally swallowed — node-crypto's error message has
    // been observed to include partial ciphertext.
    throw new ApiError(
      'PAT_DECRYPT_FAILED',
      'Stored image pull credential could not be decrypted; the credential must be re-submitted.',
      500,
      { deployment_id: deploymentId },
      // No private detail field — the message + code are all the
      // operator gets. The original `err.message` may contain
      // partial ciphertext on some Node versions and is NEVER
      // forwarded.
    );
  }
}

// ─── k8s Secret materialisation ─────────────────────────────────────────────

/**
 * Apply (create-or-patch) the dockerconfigjson Secret for a deployment.
 * Idempotent: a second call updates the existing Secret in place via
 * strategic-merge-patch.
 *
 * The cleartext token enters this function via the resolved-creds
 * object and leaves the address space when the function returns — the
 * Secret body is encoded once and never logged.
 */
export async function materializePullSecret(
  k8s: K8sClients,
  namespace: string,
  deploymentId: string,
  resolved: { registryHost: string; username: string; token: string },
): Promise<string> {
  const name = k8sPullSecretName(deploymentId);
  const dockerConfigJson = buildDockerConfigJson(resolved);
  const body = {
    metadata: {
      name,
      namespace,
      labels: {
        'platform.phoenix-host.net/deployment-id': deploymentId,
        'platform.phoenix-host.net/owner': 'custom-deployments',
      },
    },
    type: 'kubernetes.io/dockerconfigjson',
    data: {
      '.dockerconfigjson': Buffer.from(dockerConfigJson, 'utf8').toString('base64'),
    },
  } as const;

  try {
    // backup-coverage: excluded:pull-credential
    await k8s.core.createNamespacedSecret({ namespace, body });
    return name;
  } catch (err: unknown) {
    if (!is409(err)) {
      throw wrapK8sError(err, 'create', deploymentId);
    }
    // Secret exists — patch to rotate the token.
    try {
      await k8s.core.patchNamespacedSecret(
        {
          name,
          namespace,
          body: { data: body.data },
        } as unknown as Parameters<typeof k8s.core.patchNamespacedSecret>[0],
        STRATEGIC_MERGE_PATCH,
      );
      return name;
    } catch (patchErr) {
      throw wrapK8sError(patchErr, 'patch', deploymentId);
    }
  }
}

/**
 * Delete the dockerconfigjson Secret for a deployment. Idempotent —
 * a 404 from k8s is treated as success because the credential row
 * has already been deleted from the DB and the Secret may have been
 * cleaned up by an earlier call or by the namespace teardown.
 */
export async function deletePullSecret(
  k8s: K8sClients,
  namespace: string,
  deploymentId: string,
): Promise<void> {
  const name = k8sPullSecretName(deploymentId);
  try {
    await k8s.core.deleteNamespacedSecret({ name, namespace });
  } catch (err) {
    if (!is404(err)) throw wrapK8sError(err, 'delete', deploymentId);
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function rowToRecord(row: typeof customDeploymentImageCredentials.$inferSelect): PullCredentialRecord {
  return {
    id: row.id,
    deploymentId: row.deploymentId,
    registryHost: row.registryHost,
    username: row.username,
    tokenLastFour: row.tokenLastFour,
    createdAt: row.createdAt,
    rotatedAt: row.rotatedAt,
  };
}

function is404(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('HTTP-Code: 404')) return true;
  return (err as { statusCode?: number }).statusCode === 404;
}

function is409(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('HTTP-Code: 409')) return true;
  return (err as { statusCode?: number }).statusCode === 409;
}

/**
 * Convert an underlying k8s SDK error into a clean ApiError that
 * does NOT echo the response body — the body could include the
 * Secret's data field on some patch failures (the API server's error
 * messages sometimes mirror back the request payload).
 */
function wrapK8sError(err: unknown, op: 'create' | 'patch' | 'delete', deploymentId: string): ApiError {
  // Best-effort short message extraction — full body / stack are NOT
  // captured because k8s SDK error bodies have been observed to echo
  // back parts of the request payload (= leaks the dockerconfigjson).
  return new ApiError(
    'IMAGE_PULL_SECRET_K8S_ERROR',
    `Failed to ${op} image pull Secret for deployment.`,
    500,
    { deployment_id: deploymentId, operation: op },
  );
}
