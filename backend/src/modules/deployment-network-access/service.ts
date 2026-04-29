/**
 * Deployment-level Network Access service.
 *
 * Owns the per-deployment mode discriminator (public | tunneler |
 * zrok) and the FK references to the matching provider rows.
 * Mutually exclusive: a deployment can be in exactly one mode.
 *
 * This module is the front-half (DB + validation); the K8s reconciler
 * (provisioning ziti-edge-tunnel / zrok-frontdoor pods, toggling the
 * suppress_public_ingress flag on domains) lives in reconciler.ts.
 */

import { eq } from 'drizzle-orm';
import {
  deploymentNetworkAccessConfigs,
  deployments,
  clientZitiProviders,
  clientZrokAccounts,
  domains,
  ingressRoutes,
} from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import type {
  DeploymentNetworkAccessInput,
  DeploymentNetworkAccessResponse,
  NetworkAccessMode,
} from '@k8s-hosting/api-contracts';

export async function getConfig(
  db: Database,
  deploymentId: string,
): Promise<DeploymentNetworkAccessResponse | null> {
  const [row] = await db
    .select()
    .from(deploymentNetworkAccessConfigs)
    .where(eq(deploymentNetworkAccessConfigs.deploymentId, deploymentId));
  if (!row) {
    // No row = effectively 'public'. Return a synthesized default so
    // the UI can render the section without a 404.
    return {
      deploymentId,
      mode: 'public',
      zitiProviderId: null,
      zitiServiceName: null,
      zrokProviderId: null,
      zrokShareToken: null,
      passIdentityHeaders: true,
      provisioned: false,
      lastError: null,
      lastReconciledAt: null,
      publicIngressSuppressed: false,
    };
  }
  return rowToResponse(row);
}

export async function upsertConfig(
  db: Database,
  deploymentId: string,
  input: DeploymentNetworkAccessInput,
): Promise<DeploymentNetworkAccessResponse> {
  const [deployment] = await db.select().from(deployments).where(eq(deployments.id, deploymentId));
  if (!deployment) {
    throw new ApiError('NOT_FOUND', 'deployment not found', 404);
  }
  // Validate provider FKs belong to the same client.
  if (input.mode === 'tunneler' && input.zitiProviderId) {
    const [p] = await db
      .select()
      .from(clientZitiProviders)
      .where(eq(clientZitiProviders.id, input.zitiProviderId));
    if (!p || p.clientId !== deployment.clientId) {
      throw new ApiError('INVALID_PROVIDER', 'Ziti provider not found for this client', 422);
    }
  }
  if (input.mode === 'zrok' && input.zrokProviderId) {
    const [p] = await db
      .select()
      .from(clientZrokAccounts)
      .where(eq(clientZrokAccounts.id, input.zrokProviderId));
    if (!p || p.clientId !== deployment.clientId) {
      throw new ApiError('INVALID_PROVIDER', 'Zrok provider not found for this client', 422);
    }
  }

  const [existing] = await db
    .select()
    .from(deploymentNetworkAccessConfigs)
    .where(eq(deploymentNetworkAccessConfigs.deploymentId, deploymentId));

  const row = {
    mode: input.mode as NetworkAccessMode,
    zitiProviderId: input.mode === 'tunneler' ? (input.zitiProviderId ?? null) : null,
    zitiServiceName: input.mode === 'tunneler' ? (input.zitiServiceName ?? null) : null,
    zrokProviderId: input.mode === 'zrok' ? (input.zrokProviderId ?? null) : null,
    zrokShareToken: input.mode === 'zrok' ? (input.zrokShareToken ?? null) : null,
    passIdentityHeaders: input.passIdentityHeaders,
    updatedAt: new Date(),
  };

  if (existing) {
    await db
      .update(deploymentNetworkAccessConfigs)
      .set(row)
      .where(eq(deploymentNetworkAccessConfigs.deploymentId, deploymentId));
  } else {
    await db.insert(deploymentNetworkAccessConfigs).values({
      deploymentId,
      ...row,
    });
  }
  const result = await getConfig(db, deploymentId);
  if (!result) {
    throw new ApiError('INTERNAL_ERROR', 'config disappeared after upsert', 500);
  }
  return result;
}

export async function deleteConfig(db: Database, deploymentId: string): Promise<void> {
  await db
    .delete(deploymentNetworkAccessConfigs)
    .where(eq(deploymentNetworkAccessConfigs.deploymentId, deploymentId));
}

/**
 * Reconciler-facing: list every deployment in a non-public mode for
 * a client. Used to drive the per-client mesh-proxy lifecycle.
 */
export async function listMeshDeploymentsForClient(
  db: Database,
  clientId: string,
): Promise<ReadonlyArray<{
  readonly deploymentId: string;
  readonly mode: NetworkAccessMode;
  readonly zitiProviderId: string | null;
  readonly zitiServiceName: string | null;
  readonly zrokProviderId: string | null;
  readonly zrokShareToken: string | null;
}>> {
  const rows = await db
    .select({
      deploymentId: deploymentNetworkAccessConfigs.deploymentId,
      mode: deploymentNetworkAccessConfigs.mode,
      zitiProviderId: deploymentNetworkAccessConfigs.zitiProviderId,
      zitiServiceName: deploymentNetworkAccessConfigs.zitiServiceName,
      zrokProviderId: deploymentNetworkAccessConfigs.zrokProviderId,
      zrokShareToken: deploymentNetworkAccessConfigs.zrokShareToken,
    })
    .from(deploymentNetworkAccessConfigs)
    .innerJoin(deployments, eq(deployments.id, deploymentNetworkAccessConfigs.deploymentId))
    .where(eq(deployments.clientId, clientId));
  return rows.filter((r) => r.mode !== 'public') as never;
}

/**
 * Reconciler-facing: list domain rows whose deployments are in a
 * mesh-only mode (tunneler). Used to set/clear the
 * suppress_public_ingress flag on each.
 */
export async function listDomainsForDeployment(
  db: Database,
  deploymentId: string,
): Promise<ReadonlyArray<{ id: string; suppressPublicIngress: boolean }>> {
  const rows = await db
    .select({
      id: domains.id,
      suppressPublicIngress: domains.suppressPublicIngress,
    })
    .from(domains)
    .innerJoin(ingressRoutes, eq(ingressRoutes.domainId, domains.id))
    .where(eq(ingressRoutes.deploymentId, deploymentId));
  // Distinct domain ids
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

export async function setDomainSuppression(
  db: Database,
  deploymentId: string,
  suppress: boolean,
): Promise<void> {
  const ds = await listDomainsForDeployment(db, deploymentId);
  for (const d of ds) {
    if (d.suppressPublicIngress === suppress) continue;
    // eslint-disable-next-line no-await-in-loop
    await db
      .update(domains)
      .set({ suppressPublicIngress: suppress })
      .where(eq(domains.id, d.id));
  }
}

export async function markReconciled(
  db: Database,
  deploymentId: string,
  ok: boolean,
  error: string | null,
  provisioned: boolean,
  publicIngressSuppressed: boolean,
): Promise<void> {
  await db
    .update(deploymentNetworkAccessConfigs)
    .set({
      lastReconciledAt: new Date(),
      lastError: ok ? null : error,
      provisioned,
      publicIngressSuppressed,
    })
    .where(eq(deploymentNetworkAccessConfigs.deploymentId, deploymentId));
}

interface RawRow {
  readonly deploymentId: string;
  readonly mode: string;
  readonly zitiProviderId: string | null;
  readonly zitiServiceName: string | null;
  readonly zrokProviderId: string | null;
  readonly zrokShareToken: string | null;
  readonly passIdentityHeaders: boolean;
  readonly provisioned: boolean;
  readonly publicIngressSuppressed: boolean;
  readonly lastError: string | null;
  readonly lastReconciledAt: Date | null;
}

function rowToResponse(row: RawRow): DeploymentNetworkAccessResponse {
  return {
    deploymentId: row.deploymentId,
    mode: row.mode as NetworkAccessMode,
    zitiProviderId: row.zitiProviderId,
    zitiServiceName: row.zitiServiceName,
    zrokProviderId: row.zrokProviderId,
    zrokShareToken: row.zrokShareToken,
    passIdentityHeaders: row.passIdentityHeaders,
    provisioned: row.provisioned,
    publicIngressSuppressed: row.publicIngressSuppressed,
    lastError: row.lastError,
    lastReconciledAt: row.lastReconciledAt?.toISOString() ?? null,
  };
}
