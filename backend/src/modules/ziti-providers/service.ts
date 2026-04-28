/**
 * Ziti provider service — per-client OpenZiti controller registry.
 *
 * Used by the deployment-level Network Access feature (mode A:
 * tunneler). Stores controller URL + enrollment JWT (encrypted at
 * rest using OIDC_ENCRYPTION_KEY for v1) per client. The reconciler
 * (Milestone A) consumes these rows when provisioning per-client
 * ziti-edge-tunnel pods.
 */

import { randomUUID } from 'node:crypto';
import { eq, and, sql } from 'drizzle-orm';
import {
  clientZitiProviders,
  deploymentNetworkAccessConfigs,
} from '../../db/schema.js';
import { encrypt } from '../oidc/crypto.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import type {
  ZitiProviderInput,
  ZitiProviderResponse,
} from '@k8s-hosting/api-contracts';

export async function listProviders(
  db: Database,
  clientId: string,
): Promise<ReadonlyArray<ZitiProviderResponse>> {
  const rows = await db
    .select({
      id: clientZitiProviders.id,
      name: clientZitiProviders.name,
      controllerUrl: clientZitiProviders.controllerUrl,
      enrollmentJwt: clientZitiProviders.enrollmentJwtEncrypted,
      certExpiresAt: clientZitiProviders.certExpiresAt,
      createdAt: clientZitiProviders.createdAt,
      updatedAt: clientZitiProviders.updatedAt,
      consumerCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${deploymentNetworkAccessConfigs}
        WHERE ${deploymentNetworkAccessConfigs.zitiProviderId} = ${clientZitiProviders.id}
      )`,
    })
    .from(clientZitiProviders)
    .where(eq(clientZitiProviders.clientId, clientId));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    controllerUrl: r.controllerUrl,
    enrolled: r.enrollmentJwt !== null,
    certExpiresAt: r.certExpiresAt?.toISOString() ?? null,
    consumerCount: r.consumerCount,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function createProvider(
  db: Database,
  encryptionKey: string,
  clientId: string,
  input: ZitiProviderInput,
): Promise<ZitiProviderResponse> {
  if (!input.enrollmentJwt) {
    throw new ApiError(
      'ENROLLMENT_JWT_REQUIRED',
      'enrollmentJwt is required when creating a provider',
      422,
    );
  }
  const id = randomUUID();
  await db.insert(clientZitiProviders).values({
    id,
    clientId,
    name: input.name,
    controllerUrl: input.controllerUrl,
    enrollmentJwtEncrypted: encrypt(input.enrollmentJwt, encryptionKey),
  });
  const [created] = await listProvidersById(db, [id]);
  if (!created) {
    throw new ApiError('INTERNAL_ERROR', 'provider disappeared after insert', 500);
  }
  return created;
}

export async function updateProvider(
  db: Database,
  encryptionKey: string,
  clientId: string,
  providerId: string,
  input: Partial<ZitiProviderInput>,
): Promise<ZitiProviderResponse> {
  const [existing] = await db
    .select()
    .from(clientZitiProviders)
    .where(and(eq(clientZitiProviders.id, providerId), eq(clientZitiProviders.clientId, clientId)));
  if (!existing) {
    throw new ApiError('NOT_FOUND', 'Ziti provider not found', 404);
  }
  await db
    .update(clientZitiProviders)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.controllerUrl !== undefined ? { controllerUrl: input.controllerUrl } : {}),
      ...(input.enrollmentJwt !== undefined && input.enrollmentJwt
        ? { enrollmentJwtEncrypted: encrypt(input.enrollmentJwt, encryptionKey) }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(clientZitiProviders.id, providerId));
  const [updated] = await listProvidersById(db, [providerId]);
  if (!updated) {
    throw new ApiError('INTERNAL_ERROR', 'provider disappeared after update', 500);
  }
  return updated;
}

export async function deleteProvider(
  db: Database,
  clientId: string,
  providerId: string,
): Promise<void> {
  // FK ON DELETE RESTRICT will reject this when consumers exist; we
  // pre-check so we can return a 409 with a clear message rather than
  // a 500 from a raw FK violation.
  const consumers = await db
    .select()
    .from(deploymentNetworkAccessConfigs)
    .where(eq(deploymentNetworkAccessConfigs.zitiProviderId, providerId));
  if (consumers.length > 0) {
    throw new ApiError(
      'PROVIDER_IN_USE',
      `Provider is referenced by ${consumers.length} deployment(s); detach them first`,
      409,
    );
  }
  await db
    .delete(clientZitiProviders)
    .where(and(eq(clientZitiProviders.id, providerId), eq(clientZitiProviders.clientId, clientId)));
}

async function listProvidersById(
  db: Database,
  ids: ReadonlyArray<string>,
): Promise<ReadonlyArray<ZitiProviderResponse>> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: clientZitiProviders.id,
      name: clientZitiProviders.name,
      controllerUrl: clientZitiProviders.controllerUrl,
      enrollmentJwt: clientZitiProviders.enrollmentJwtEncrypted,
      certExpiresAt: clientZitiProviders.certExpiresAt,
      createdAt: clientZitiProviders.createdAt,
      updatedAt: clientZitiProviders.updatedAt,
      consumerCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${deploymentNetworkAccessConfigs}
        WHERE ${deploymentNetworkAccessConfigs.zitiProviderId} = ${clientZitiProviders.id}
      )`,
    })
    .from(clientZitiProviders)
    .where(eq(clientZitiProviders.id, ids[0]!));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    controllerUrl: r.controllerUrl,
    enrolled: r.enrollmentJwt !== null,
    certExpiresAt: r.certExpiresAt?.toISOString() ?? null,
    consumerCount: r.consumerCount,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}
