/**
 * Zrok provider service — per-client zrok controller registry.
 *
 * Used by the deployment-level Network Access feature (mode C: zrok
 * private share). Stores controller URL (BYO — defaults to public
 * https://api.zrok.io but supports self-hosted) + account email +
 * token (encrypted at rest).
 */

import { randomUUID } from 'node:crypto';
import { eq, and, sql } from 'drizzle-orm';
import {
  clientZrokAccounts,
  deploymentNetworkAccessConfigs,
} from '../../db/schema.js';
import { encrypt } from '../oidc/crypto.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import type {
  ZrokProviderInput,
  ZrokProviderResponse,
} from '@k8s-hosting/api-contracts';

export async function listProviders(
  db: Database,
  clientId: string,
): Promise<ReadonlyArray<ZrokProviderResponse>> {
  const rows = await db
    .select({
      id: clientZrokAccounts.id,
      name: clientZrokAccounts.name,
      controllerUrl: clientZrokAccounts.controllerUrl,
      accountEmail: clientZrokAccounts.accountEmail,
      accountTokenEncrypted: clientZrokAccounts.accountTokenEncrypted,
      createdAt: clientZrokAccounts.createdAt,
      updatedAt: clientZrokAccounts.updatedAt,
      consumerCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${deploymentNetworkAccessConfigs}
        WHERE ${deploymentNetworkAccessConfigs.zrokProviderId} = ${clientZrokAccounts.id}
      )`,
    })
    .from(clientZrokAccounts)
    .where(eq(clientZrokAccounts.clientId, clientId));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    controllerUrl: r.controllerUrl,
    accountEmail: r.accountEmail,
    tokenSet: Boolean(r.accountTokenEncrypted),
    consumerCount: r.consumerCount,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function createProvider(
  db: Database,
  encryptionKey: string,
  clientId: string,
  input: ZrokProviderInput,
): Promise<ZrokProviderResponse> {
  if (!input.accountToken) {
    throw new ApiError(
      'ACCOUNT_TOKEN_REQUIRED',
      'accountToken is required when creating a provider',
      422,
    );
  }
  const id = randomUUID();
  await db.insert(clientZrokAccounts).values({
    id,
    clientId,
    name: input.name,
    controllerUrl: input.controllerUrl,
    accountEmail: input.accountEmail,
    accountTokenEncrypted: encrypt(input.accountToken, encryptionKey),
  });
  const all = await listProviders(db, clientId);
  const created = all.find((p) => p.id === id);
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
  input: Partial<ZrokProviderInput>,
): Promise<ZrokProviderResponse> {
  const [existing] = await db
    .select()
    .from(clientZrokAccounts)
    .where(and(eq(clientZrokAccounts.id, providerId), eq(clientZrokAccounts.clientId, clientId)));
  if (!existing) {
    throw new ApiError('NOT_FOUND', 'Zrok provider not found', 404);
  }
  await db
    .update(clientZrokAccounts)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.controllerUrl !== undefined ? { controllerUrl: input.controllerUrl } : {}),
      ...(input.accountEmail !== undefined ? { accountEmail: input.accountEmail } : {}),
      ...(input.accountToken !== undefined && input.accountToken
        ? { accountTokenEncrypted: encrypt(input.accountToken, encryptionKey) }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(clientZrokAccounts.id, providerId));
  const all = await listProviders(db, clientId);
  const updated = all.find((p) => p.id === providerId);
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
  const consumers = await db
    .select()
    .from(deploymentNetworkAccessConfigs)
    .where(eq(deploymentNetworkAccessConfigs.zrokProviderId, providerId));
  if (consumers.length > 0) {
    throw new ApiError(
      'PROVIDER_IN_USE',
      `Provider is referenced by ${consumers.length} deployment(s); detach them first`,
      409,
    );
  }
  await db
    .delete(clientZrokAccounts)
    .where(and(eq(clientZrokAccounts.id, providerId), eq(clientZrokAccounts.clientId, clientId)));
}
