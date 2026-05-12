// Custom Deployments — orchestration layer.
//
// Bridges the HTTP routes to the validator, k8s deployer, PAT store
// and DB. Lives BESIDE `deployments/service.ts` (catalog) — both
// modules operate on the same `deployments` table, discriminated by
// the `source` column (ADR-036).
//
// PR-2 scope: simple-mode only. Compose-mode submissions are 400'd
// at the route layer (see routes.ts) until PR-3 ships the parser.

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { deployments, clients } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { getSettings } from '../system-settings/service.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  validateCustomSpec,
  type ValidatorContext,
} from './validator.js';
import {
  deployCustomDeployment,
  deleteCustomDeployment,
} from './k8s-deployer.js';
import {
  upsertPullCredential,
  getPullCredential,
  deletePullCredential,
  loadDecryptedToken,
  materializePullSecret,
  deletePullSecret,
  type PatSubmission,
  type PullCredentialRecord,
} from './pat-store.js';
import { recordImageAudit } from './image-audit.js';
import {
  type CustomDeploymentSpec,
  type CustomDeploymentIssue,
  type CreateCustomDeploymentSimpleInput,
  type UpdateCustomDeploymentInput,
} from './schema.js';
import { CUSTOM_SPEC_VERSION } from './schema.js';

type CallerRole = ValidatorContext['callerRole'];

interface CallerCtx {
  readonly role: CallerRole;
}

export interface CustomDeploymentRow {
  readonly id: string;
  readonly clientId: string;
  readonly name: string;
  readonly status: string;
  readonly customSpec: CustomDeploymentSpec;
  readonly storagePath: string | null;
  readonly currentNodeName: string | null;
  readonly statusMessage: string | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// ─── Read ────────────────────────────────────────────────────────────────────

export async function listCustomDeployments(
  db: Database,
  clientId: string,
): Promise<readonly CustomDeploymentRow[]> {
  const rows = await db.select().from(deployments)
    .where(and(eq(deployments.clientId, clientId), eq(deployments.source, 'custom')))
    .orderBy(desc(deployments.createdAt));
  return rows.map(toRow);
}

export async function getCustomDeployment(
  db: Database,
  clientId: string,
  id: string,
): Promise<CustomDeploymentRow> {
  const [row] = await db.select().from(deployments)
    .where(and(
      eq(deployments.id, id),
      eq(deployments.clientId, clientId),
      eq(deployments.source, 'custom'),
    ));
  if (!row) {
    throw new ApiError(
      'CUSTOM_DEPLOYMENT_NOT_FOUND',
      `Custom deployment '${id}' not found`,
      404,
      { deployment_id: id },
    );
  }
  return toRow(row);
}

// ─── Create ──────────────────────────────────────────────────────────────────

/**
 * Validate a simple-form spec without persisting or deploying it.
 * Used by the wizard's "preview" step.
 */
export async function validateSimpleSpec(
  db: Database,
  input: CreateCustomDeploymentSimpleInput,
  ctx: CallerCtx,
): Promise<{ ok: boolean; issues: readonly CustomDeploymentIssue[]; spec: CustomDeploymentSpec }> {
  const spec = buildSpecFromSimple(input);
  const settings = await getSettings(db);
  const result = validateCustomSpec(spec, {
    callerRole: ctx.role,
    warnUnpinnedTags: settings.customDeploymentsWarnUnpinnedTags,
    singleServiceOnly: true,
    deploymentName: input.name,
  });
  return { ok: result.ok, issues: result.issues, spec };
}

export async function createSimpleDeployment(
  db: Database,
  k8s: K8sClients,
  clientId: string,
  input: CreateCustomDeploymentSimpleInput,
  ctx: CallerCtx,
): Promise<CustomDeploymentRow> {
  const settings = await getSettings(db);
  if (!settings.customDeploymentsEnabled) {
    throw new ApiError(
      'CUSTOM_DEPLOYMENTS_DISABLED',
      'Custom deployments are administratively disabled on this platform.',
      403,
    );
  }

  const namespace = await loadClientNamespace(db, clientId);

  // Build + validate the normalized spec.
  const spec = buildSpecFromSimple(input);
  const validation = validateCustomSpec(spec, {
    callerRole: ctx.role,
    warnUnpinnedTags: settings.customDeploymentsWarnUnpinnedTags,
    singleServiceOnly: true,
    deploymentName: input.name,
  });
  if (!validation.ok) {
    throw new ApiError(
      'CUSTOM_DEPLOYMENT_INVALID',
      firstErrorIssue(validation.issues),
      422,
      { issues: validation.issues },
    );
  }

  // Uniqueness: per-client deployment name (catalog already enforces
  // this on the same `deployments_client_name_unique` constraint).
  const existing = await db.select().from(deployments)
    .where(and(eq(deployments.clientId, clientId), eq(deployments.name, input.name)));
  if (existing.length > 0) {
    throw new ApiError(
      'DEPLOYMENT_NAME_IN_USE',
      `A deployment named '${input.name}' already exists in this client.`,
      409,
      { name: input.name },
    );
  }

  // Persist row first — k8s apply happens AFTER the DB row exists so
  // a deploy failure leaves a `failed` row the operator can see and
  // retry (matches the catalog path).
  const id = randomUUID();
  const storagePath = `custom/${input.name}`;
  await db.insert(deployments).values({
    id,
    clientId,
    catalogEntryId: null,
    source: 'custom',
    customSpec: spec as unknown as Record<string, unknown>,
    name: input.name,
    replicaCount: 1,
    cpuRequest: spec.services[input.name].resources.cpuRequest,
    memoryRequest: spec.services[input.name].resources.memoryRequest,
    configuration: null,
    storagePath,
    status: 'deploying',
  });

  await deployToCluster(db, k8s, id, namespace, input.name, storagePath, spec);

  return getCustomDeployment(db, clientId, id);
}

// ─── Update ──────────────────────────────────────────────────────────────────

/**
 * Apply a narrow patch to a custom deployment. Role-gating: the route
 * layer already checks `requireClientRoleByMethod` (writes need
 * client_admin+); the validator below uses hardcoded `'admin'` for
 * `callerRole` because patches CANNOT alter the admin-only allowRoot
 * flag (it's not in `UpdateCustomDeploymentInput`). Adding a CallerCtx
 * parameter here would be dead surface that risks a future caller
 * mistakenly thinking they can elevate via this entrypoint.
 */
export async function updateCustomDeployment(
  db: Database,
  k8s: K8sClients,
  clientId: string,
  id: string,
  patch: UpdateCustomDeploymentInput,
): Promise<CustomDeploymentRow> {
  const current = await getCustomDeployment(db, clientId, id);
  let nextSpec = current.customSpec;
  let needsRedeploy = false;

  // The simple-mode update surface (per PR-2) lets the tenant:
  //   - rotate the image tag (one-click "Update available" flow)
  //   - replace the env block
  //   - tweak resources
  //   - attach / detach an image-pull credential
  //   - request an explicit `restart` (forces a redeploy with the
  //     current spec — used by the UI restart button)
  const serviceName = Object.keys(current.customSpec.services)[0];
  if (!serviceName) {
    throw new ApiError(
      'CUSTOM_DEPLOYMENT_CORRUPT',
      'Custom deployment has no services in spec.',
      500,
    );
  }
  // Force-read the service to surface a clear error if it's missing
  // — without this the patch chain below would silently no-op.
  if (!nextSpec.services[serviceName]) {
    throw new ApiError('CUSTOM_DEPLOYMENT_CORRUPT', 'Spec service entry is missing.', 500);
  }

  if (patch.image !== undefined) {
    nextSpec = withServiceMutation(nextSpec, serviceName, (s) => ({ ...s, image: patch.image! }));
    needsRedeploy = true;
  }
  if (patch.env !== undefined) {
    nextSpec = withServiceMutation(nextSpec, serviceName, (s) => ({ ...s, env: patch.env! }));
    needsRedeploy = true;
  }
  if (patch.resources !== undefined) {
    nextSpec = withServiceMutation(nextSpec, serviceName, (s) => ({ ...s, resources: { ...s.resources, ...patch.resources! } }));
    needsRedeploy = true;
  }
  if (patch.pull_credential_id !== undefined) {
    nextSpec = { ...nextSpec, pullCredentialId: patch.pull_credential_id ?? undefined };
    needsRedeploy = true;
  }
  if (patch.restart) {
    needsRedeploy = true;
  }

  if (!needsRedeploy) return current;

  // Re-validate so a patch that introduces an invalid combination is
  // rejected before any cluster mutation. callerRole is hardcoded to
  // 'admin' here because the previously-validated spec may carry an
  // admin-set allowRoot=true; we never want a client-initiated patch
  // (image bump, restart) to fail the ALLOW_ROOT_REQUIRES_ADMIN check
  // for a flag the client didn't touch. The update schema does NOT
  // expose `allowRoot` (admin-only post-create knob), so there's no
  // path for a client to escalate via this elevation.
  const settings = await getSettings(db);
  const validation = validateCustomSpec(nextSpec, {
    callerRole: 'admin',
    warnUnpinnedTags: settings.customDeploymentsWarnUnpinnedTags,
    singleServiceOnly: true,
    deploymentName: current.name,
  });
  if (!validation.ok) {
    throw new ApiError(
      'CUSTOM_DEPLOYMENT_INVALID',
      firstErrorIssue(validation.issues),
      422,
      { issues: validation.issues },
    );
  }

  // Touch only the fields that changed.
  const updatedService = nextSpec.services[serviceName];
  await db.update(deployments)
    .set({
      customSpec: nextSpec as unknown as Record<string, unknown>,
      cpuRequest: updatedService.resources.cpuRequest,
      memoryRequest: updatedService.resources.memoryRequest,
      status: 'deploying',
      statusMessage: null,
      lastError: null,
    })
    .where(eq(deployments.id, id));

  const namespace = await loadClientNamespace(db, clientId);
  await deployToCluster(db, k8s, id, namespace, current.name, current.storagePath ?? `custom/${current.name}`, nextSpec);

  return getCustomDeployment(db, clientId, id);
}

// ─── Upgrade-tag (one-click) ────────────────────────────────────────────────

export async function upgradeTag(
  db: Database,
  k8s: K8sClients,
  clientId: string,
  id: string,
  newImage: string,
): Promise<CustomDeploymentRow> {
  return updateCustomDeployment(db, k8s, clientId, id, { image: newImage });
}

// ─── Delete ──────────────────────────────────────────────────────────────────

export async function deleteCustomDeploymentRow(
  db: Database,
  k8s: K8sClients,
  clientId: string,
  id: string,
): Promise<void> {
  const current = await getCustomDeployment(db, clientId, id);
  const namespace = await loadClientNamespace(db, clientId);

  // Mark as deleting BEFORE the cluster mutation so a concurrent
  // reconciler tick doesn't bring it back to `running`.
  await db.update(deployments)
    .set({ status: 'deleting' })
    .where(eq(deployments.id, id));

  try {
    await deleteCustomDeployment(k8s, namespace, id, current.name);
    await deletePullSecret(k8s, namespace, id);
  } catch (err) {
    await db.update(deployments)
      .set({
        status: 'failed',
        lastError: err instanceof Error ? err.message : String(err),
      })
      .where(eq(deployments.id, id));
    throw err;
  }

  // The credentials row cascades on the deployment row delete, but
  // we still call deletePullCredential() defensively in case the FK
  // CASCADE is removed in a future migration.
  await deletePullCredential(db, id);
  await db.delete(deployments).where(eq(deployments.id, id));
}

// ─── PAT (pull credentials) ─────────────────────────────────────────────────

export async function attachPullCredential(
  db: Database,
  k8s: K8sClients,
  clientId: string,
  deploymentId: string,
  submission: PatSubmission,
  encryptionKey: string,
): Promise<PullCredentialRecord> {
  const settings = await getSettings(db);
  if (!settings.customDeploymentsAllowPrivateRegistries) {
    throw new ApiError(
      'PRIVATE_REGISTRIES_DISABLED',
      'Private registries are administratively disabled on this platform.',
      403,
    );
  }
  // Ownership check.
  await getCustomDeployment(db, clientId, deploymentId);
  const record = await upsertPullCredential(db, deploymentId, submission, encryptionKey);

  // Materialise the k8s Secret immediately so the next pod restart
  // picks up the new credentials. The deployment isn't redeployed
  // here — the operator can call /restart explicitly if they want
  // the pull to happen now.
  const namespace = await loadClientNamespace(db, clientId);
  await materializePullSecret(k8s, namespace, deploymentId, {
    registryHost: submission.registryHost,
    username: submission.username,
    token: submission.token,
  });
  return record;
}

export async function revokePullCredential(
  db: Database,
  k8s: K8sClients,
  clientId: string,
  deploymentId: string,
): Promise<void> {
  await getCustomDeployment(db, clientId, deploymentId);
  const namespace = await loadClientNamespace(db, clientId);
  await deletePullSecret(k8s, namespace, deploymentId);
  await deletePullCredential(db, deploymentId);
}

export async function readPullCredentialPublic(
  db: Database,
  clientId: string,
  deploymentId: string,
): Promise<PullCredentialRecord | null> {
  await getCustomDeployment(db, clientId, deploymentId);
  return getPullCredential(db, deploymentId);
}

// ─── Cluster apply ──────────────────────────────────────────────────────────

async function deployToCluster(
  db: Database,
  k8s: K8sClients,
  deploymentId: string,
  namespace: string,
  deploymentName: string,
  storageSubPath: string,
  spec: CustomDeploymentSpec,
): Promise<void> {
  const hasPullCredential = await getPullCredential(db, deploymentId);
  if (hasPullCredential) {
    // The deployer is about to set `imagePullSecrets: [image-pull-X]`
    // on the Pod. If we silently skip re-materialisation because the
    // platform can't decrypt the token, the Pod hits ImagePullBackOff
    // with no operator-visible signal. Fail loudly instead — the
    // operator sees `ENCRYPTION_KEY_MISSING` / `PAT_DECRYPT_FAILED`
    // on the deployment row and can act.
    if (!process.env.OIDC_ENCRYPTION_KEY) {
      throw new ApiError(
        'ENCRYPTION_KEY_MISSING',
        'Cannot re-materialise the image-pull Secret without OIDC_ENCRYPTION_KEY; this deployment is configured to use a PAT.',
        500,
        { deployment_id: deploymentId },
      );
    }
    const decrypted = await loadDecryptedToken(db, deploymentId, process.env.OIDC_ENCRYPTION_KEY);
    if (!decrypted) {
      // DB row was deleted between the getPullCredential check and the
      // load — shouldn't happen under normal locking, but if it does
      // the Pod's imagePullSecrets ref would still point at a missing
      // Secret. Drop the ref instead of leaving a dangling reference.
      throw new ApiError(
        'PAT_VANISHED',
        'Image-pull credential disappeared between read and apply.',
        500,
        { deployment_id: deploymentId },
      );
    }
    await materializePullSecret(k8s, namespace, deploymentId, decrypted);
  }

  try {
    await deployCustomDeployment(k8s, {
      deploymentId,
      deploymentName,
      namespace,
      storageSubPath,
      spec,
      hasPullCredential: !!hasPullCredential,
    });
    // Optimistic: status flips to running on the next reconciler tick
    // when k8s reports ready replicas. Until then it stays 'deploying'.
    // Fire-and-forget image-audit so the audit trail starts populating
    // ASAP without blocking the deploy response. Errors are swallowed
    // (the next reconciler tick will retry).
    void recordImageAudit(db, k8s, deploymentId, namespace, deploymentName).catch(() => undefined);
  } catch (err) {
    await db.update(deployments)
      .set({
        status: 'failed',
        lastError: err instanceof Error ? err.message : String(err),
      })
      .where(eq(deployments.id, deploymentId));
    throw err;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function loadClientNamespace(db: Database, clientId: string): Promise<string> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client) {
    throw new ApiError('CLIENT_NOT_FOUND', `Client '${clientId}' not found`, 404, { client_id: clientId });
  }
  return client.kubernetesNamespace;
}

function buildSpecFromSimple(input: CreateCustomDeploymentSimpleInput): CustomDeploymentSpec {
  // The single service is named the same as the deployment.
  // PR-3 (compose) will produce multi-service maps.
  const serviceName = input.name;
  return {
    specVersion: CUSTOM_SPEC_VERSION,
    sourceMode: 'simple',
    services: {
      [serviceName]: {
        image: input.image,
        command: input.command,
        entrypoint: input.entrypoint,
        env: input.env ?? [],
        ports: input.ports ?? [],
        volumeMounts: input.volumes ?? [],
        resources: input.resources ?? { cpuRequest: '100m', memoryRequest: '128Mi' },
        healthCheck: input.health_check,
        restartPolicy: input.restart_policy ?? 'Always',
        runAsUser: input.run_as_user,
        runAsGroup: input.run_as_group,
        readOnlyRootFilesystem: input.read_only_root_filesystem ?? false,
        tmpfs: [],
        dependsOn: [],
        workingDir: undefined,
        stopGracePeriodSeconds: undefined,
      },
    },
    // Volume names referenced by mounts must exist as top-level
    // entries. Build them implicitly from the mount list so the
    // tenant doesn't need to declare them twice in the simple form.
    volumes: Object.fromEntries(
      (input.volumes ?? []).map((vm) => [vm.name, {}] as const),
    ),
    configMaps: [],
    secrets: [],
    allowRoot: false,
    pullCredentialId: input.pull_credential_id,
  };
}

function withServiceMutation(
  spec: CustomDeploymentSpec,
  serviceName: string,
  fn: (s: CustomDeploymentSpec['services'][string]) => CustomDeploymentSpec['services'][string],
): CustomDeploymentSpec {
  return {
    ...spec,
    services: { ...spec.services, [serviceName]: fn(spec.services[serviceName]) },
  };
}

function firstErrorIssue(issues: readonly CustomDeploymentIssue[]): string {
  const err = issues.find((i) => i.severity === 'error');
  return err ? `${err.code}: ${err.message}` : 'Validation failed';
}

function toRow(row: typeof deployments.$inferSelect): CustomDeploymentRow {
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    status: row.status,
    customSpec: row.customSpec as unknown as CustomDeploymentSpec,
    storagePath: row.storagePath,
    currentNodeName: row.currentNodeName,
    statusMessage: row.statusMessage,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
