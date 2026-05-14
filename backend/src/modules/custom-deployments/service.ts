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
  type CreateCustomDeploymentComposeInput,
  type UpdateCustomDeploymentInput,
} from './schema.js';
import { CUSTOM_SPEC_VERSION } from './schema.js';
import { parseCompose } from './compose-parser.js';

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

  const { namespace, workerNodeName, storageTier } = await loadClientContext(db, clientId);

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
  const storagePath = `custom-deployment/${input.name}`;
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

  await deployToCluster(db, k8s, id, namespace, input.name, storagePath, spec, workerNodeName, storageTier);

  return getCustomDeployment(db, clientId, id);
}

// ─── Compose create / validate ──────────────────────────────────────────────

/**
 * Validate a compose-form spec without persisting or deploying it.
 * Used by the editor's preview step. Returns parser issues + the
 * normalized spec (when parse succeeded) so the editor can render
 * the "Issues" pane and the "Rendered" tab side by side.
 */
export async function validateComposeSpec(
  db: Database,
  input: { composeYaml: string; envFiles?: Record<string, string>; name?: string },
  ctx: CallerCtx,
): Promise<{ ok: boolean; issues: readonly CustomDeploymentIssue[]; spec: CustomDeploymentSpec | null }> {
  const settings = await getSettings(db);
  // Same gate as createComposeDeployment — operators disabling
  // compose to contain blast radius should see the preview path
  // also reject, not silently keep echoing the parser surface.
  if (!settings.customDeploymentsAllowCompose) {
    throw new ApiError(
      'COMPOSE_DEPLOYMENTS_DISABLED',
      'Compose-mode deployments are administratively disabled on this platform.',
      403,
    );
  }
  const parsed = parseCompose({ composeYaml: input.composeYaml, envFiles: input.envFiles });
  if (!parsed.spec) {
    return { ok: false, issues: parsed.issues, spec: null };
  }
  const semantic = validateCustomSpec(parsed.spec, {
    callerRole: ctx.role,
    warnUnpinnedTags: settings.customDeploymentsWarnUnpinnedTags,
    singleServiceOnly: false,
    deploymentName: input.name,
  });
  // Merge parser issues + validator issues for the editor's pane.
  const allIssues = [...parsed.issues, ...semantic.issues];
  return { ok: semantic.ok, issues: allIssues, spec: parsed.spec };
}

/**
 * Persist + apply a compose-form deployment. Mirrors
 * `createSimpleDeployment` but with the compose parser feeding the
 * normalized spec, and multi-service stacks allowed.
 */
export async function createComposeDeployment(
  db: Database,
  k8s: K8sClients,
  clientId: string,
  input: CreateCustomDeploymentComposeInput,
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
  if (!settings.customDeploymentsAllowCompose) {
    throw new ApiError(
      'COMPOSE_DEPLOYMENTS_DISABLED',
      'Compose-mode deployments are administratively disabled on this platform.',
      403,
    );
  }

  if (!input.name) {
    throw new ApiError('MISSING_REQUIRED_FIELD', 'Stack name is required to create a deployment.', 400, { field: 'name' });
  }

  const { namespace, workerNodeName, storageTier } = await loadClientContext(db, clientId);

  // Phase 1: parse → validate → reject if errors.
  const parsed = parseCompose({ composeYaml: input.compose_yaml, envFiles: input.env_files });
  if (!parsed.spec) {
    throw new ApiError(
      'CUSTOM_DEPLOYMENT_INVALID',
      firstErrorIssue(parsed.issues),
      422,
      { issues: parsed.issues },
    );
  }
  const validation = validateCustomSpec(parsed.spec, {
    callerRole: ctx.role,
    warnUnpinnedTags: settings.customDeploymentsWarnUnpinnedTags,
    singleServiceOnly: false,
    deploymentName: input.name,
  });
  if (!validation.ok) {
    throw new ApiError(
      'CUSTOM_DEPLOYMENT_INVALID',
      firstErrorIssue([...parsed.issues, ...validation.issues]),
      422,
      { issues: [...parsed.issues, ...validation.issues] },
    );
  }

  // Uniqueness — per the existing deployments_client_name_unique constraint.
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

  // For multi-service, the row-level resource fields summarise the
  // stack as the SUM of all services. Used for UI display + future
  // plan-quota math. The customSpec carries per-service values.
  const totals = sumResources(parsed.spec);

  // Attach PAT id from the input (compose body never carries
  // cleartext credentials — those go through the PAT routes).
  // ParseResult.spec is `readonly`, so we copy with the field set
  // rather than reassigning.
  const finalSpec: CustomDeploymentSpec = input.pull_credential_id
    ? { ...parsed.spec, pullCredentialId: input.pull_credential_id }
    : parsed.spec;

  const id = randomUUID();
  const storagePath = `custom-deployment/${input.name}`;
  await db.insert(deployments).values({
    id,
    clientId,
    catalogEntryId: null,
    source: 'custom',
    customSpec: finalSpec as unknown as Record<string, unknown>,
    name: input.name,
    replicaCount: 1,
    cpuRequest: totals.cpuRequest,
    memoryRequest: totals.memoryRequest,
    configuration: null,
    storagePath,
    status: 'deploying',
  });

  await deployToCluster(db, k8s, id, namespace, input.name, storagePath, finalSpec, workerNodeName, storageTier);
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
  const isCompose = current.customSpec.sourceMode === 'compose';

  // The PATCH surface in PR-3 supports two flavours:
  //   - Simple-mode (single service): image / env / resources land on
  //     the lone service. Tag-upgrade and env tweaks go through here.
  //   - Compose-mode (multi-service): per-service mutation is NOT
  //     exposed in PR-3 (the UpdateCustomDeploymentInput schema has
  //     no service selector). Compose stacks accept ONLY `restart`
  //     and `pull_credential_id` patches in this PR; image/env/
  //     resources patches return NOT_SUPPORTED_FOR_COMPOSE so the
  //     operator knows to drop into the YAML editor (PR-4) for a
  //     per-service change.
  const serviceName = Object.keys(current.customSpec.services)[0];
  if (!serviceName || !nextSpec.services[serviceName]) {
    throw new ApiError(
      'CUSTOM_DEPLOYMENT_CORRUPT',
      'Custom deployment has no services in spec.',
      500,
    );
  }

  const composeReject = (field: string): never => {
    throw new ApiError(
      'NOT_SUPPORTED_FOR_COMPOSE',
      `Patching '${field}' on a compose-mode deployment is not supported in this release; edit the compose YAML and recreate, or wait for the per-service patch surface in the next release.`,
      400,
      { field },
    );
  };

  if (patch.image !== undefined) {
    if (isCompose) composeReject('image');
    nextSpec = withServiceMutation(nextSpec, serviceName, (s) => ({ ...s, image: patch.image! }));
    needsRedeploy = true;
  }
  if (patch.env !== undefined) {
    if (isCompose) composeReject('env');
    nextSpec = withServiceMutation(nextSpec, serviceName, (s) => ({ ...s, env: patch.env! }));
    needsRedeploy = true;
  }
  if (patch.resources !== undefined) {
    if (isCompose) composeReject('resources');
    nextSpec = withServiceMutation(nextSpec, serviceName, (s) => ({ ...s, resources: { ...s.resources, ...patch.resources! } }));
    needsRedeploy = true;
  }
  if (patch.ports !== undefined) {
    if (isCompose) composeReject('ports');
    nextSpec = withServiceMutation(nextSpec, serviceName, (s) => ({ ...s, ports: patch.ports! }));
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
  //
  // `singleServiceOnly` mirrors the source mode — compose stacks
  // get the multi-service validator path so the existing N-service
  // spec doesn't trip COMPOSE_NOT_SUPPORTED_YET.
  const settings = await getSettings(db);
  const validation = validateCustomSpec(nextSpec, {
    callerRole: 'admin',
    warnUnpinnedTags: settings.customDeploymentsWarnUnpinnedTags,
    singleServiceOnly: !isCompose,
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

  // Row-level totals: compose stacks sum across services, simple
  // mode uses the (only) service's own values directly. Keeps the
  // row's cpu/memory request aligned with the actual cluster
  // footprint so plan-quota math stays honest.
  const updatedService = nextSpec.services[serviceName];
  const totals = isCompose
    ? sumResources(nextSpec)
    : {
      cpuRequest: updatedService.resources.cpuRequest,
      memoryRequest: updatedService.resources.memoryRequest,
    };
  await db.update(deployments)
    .set({
      customSpec: nextSpec as unknown as Record<string, unknown>,
      cpuRequest: totals.cpuRequest,
      memoryRequest: totals.memoryRequest,
      status: 'deploying',
      statusMessage: null,
      lastError: null,
    })
    .where(eq(deployments.id, id));

  const { namespace, workerNodeName, storageTier } = await loadClientContext(db, clientId);
  await deployToCluster(db, k8s, id, namespace, current.name, current.storagePath ?? `custom-deployment/${current.name}`, nextSpec, workerNodeName, storageTier);

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

/**
 * Admin-only: flip the `allowRoot` flag on an existing deployment.
 * Does NOT trigger a re-deploy — the tenant must re-apply the spec
 * (restart or update) after the admin flips this flag.
 *
 * Caller MUST have verified super_admin role before calling this.
 */
export async function setAllowRoot(
  db: Database,
  clientId: string,
  deploymentId: string,
  allowRoot: boolean,
): Promise<CustomDeploymentRow> {
  const current = await getCustomDeployment(db, clientId, deploymentId);
  const nextSpec: CustomDeploymentSpec = { ...current.customSpec, allowRoot };
  const [updated] = await db
    .update(deployments)
    .set({ customSpec: nextSpec as unknown as Record<string, unknown> })
    .where(and(eq(deployments.id, deploymentId), eq(deployments.clientId, clientId), eq(deployments.source, 'custom')))
    .returning();
  if (!updated) {
    throw new ApiError('CUSTOM_DEPLOYMENT_NOT_FOUND', `Deployment '${deploymentId}' not found`, 404);
  }
  return toRow(updated);
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
  workerNodeName?: string | null,
  storageTier?: 'local' | 'ha' | null,
): Promise<void> {
  const hasPullCredential = await getPullCredential(db, deploymentId);
  if (hasPullCredential) {
    // The deployer is about to set `imagePullSecrets: [image-pull-X]`
    // on the Pod. If we silently skip re-materialisation because the
    // platform can't decrypt the token, the Pod hits ImagePullBackOff
    // with no operator-visible signal. Fail loudly instead — the
    // operator sees `ENCRYPTION_KEY_MISSING` / `PAT_DECRYPT_FAILED`
    // on the deployment row and can act.
    if (!process.env.PLATFORM_ENCRYPTION_KEY) {
      throw new ApiError(
        'ENCRYPTION_KEY_MISSING',
        'Cannot re-materialise the image-pull Secret without PLATFORM_ENCRYPTION_KEY; this deployment is configured to use a PAT.',
        500,
        { deployment_id: deploymentId },
      );
    }
    const decrypted = await loadDecryptedToken(db, deploymentId, process.env.PLATFORM_ENCRYPTION_KEY);
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
      workerNodeName: workerNodeName ?? undefined,
      storageTier: storageTier ?? undefined,
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

interface ClientContext {
  readonly namespace: string;
  readonly workerNodeName: string | null;
  readonly storageTier: 'local' | 'ha';
}

async function loadClientContext(db: Database, clientId: string): Promise<ClientContext> {
  const [client] = await db
    .select({
      kubernetesNamespace: clients.kubernetesNamespace,
      workerNodeName: clients.workerNodeName,
      storageTier: clients.storageTier,
    })
    .from(clients)
    .where(eq(clients.id, clientId));
  if (!client) {
    throw new ApiError('CLIENT_NOT_FOUND', `Client '${clientId}' not found`, 404, { client_id: clientId });
  }
  return {
    namespace: client.kubernetesNamespace,
    workerNodeName: client.workerNodeName ?? null,
    storageTier: (client.storageTier ?? 'local') as 'local' | 'ha',
  };
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
        capAdd: [],
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

/**
 * Sum the per-service `cpuRequest` + `memoryRequest` to produce a
 * row-level "stack total" stored on `deployments.cpu_request` and
 * `deployments.memory_request`. Used for UI display and future
 * plan-quota math. The per-service values stay in `customSpec` and
 * drive what the deployer puts into each container.
 */
function sumResources(spec: CustomDeploymentSpec): { cpuRequest: string; memoryRequest: string } {
  let cpuMillis = 0;
  let memMi = 0;
  for (const svc of Object.values(spec.services)) {
    cpuMillis += parseCpuMillis(svc.resources.cpuRequest);
    memMi += parseMemMi(svc.resources.memoryRequest);
  }
  return {
    cpuRequest: `${cpuMillis || 100}m`,
    memoryRequest: `${memMi || 128}Mi`,
  };
}

function parseCpuMillis(qty: string): number {
  const m = /^([0-9]+(?:\.[0-9]+)?)(m)?$/.exec(qty);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return m[2] === 'm' ? Math.round(n) : Math.round(n * 1000);
}

function parseMemMi(qty: string): number {
  const m = /^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti|k|M|G|T)?$/.exec(qty);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2] ?? '';
  const factor: Record<string, number> = {
    '': 1 / (1024 * 1024),
    k: 1000 / (1024 * 1024), M: 1_000_000 / (1024 * 1024), G: 1_000_000_000 / (1024 * 1024),
    Ki: 1 / 1024, Mi: 1, Gi: 1024, Ti: 1024 * 1024,
  };
  return Math.max(1, Math.round(n * (factor[unit] ?? 1)));
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
