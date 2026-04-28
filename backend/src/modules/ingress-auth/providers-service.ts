/**
 * Per-client OIDC provider CRUD.
 *
 * Providers are reusable across N ingresses for the same client.
 * Secret encryption uses the existing OIDC_ENCRYPTION_KEY (32-byte
 * hex). Secrets are NEVER returned in responses; only a `secretSet`
 * flag exposes presence.
 *
 * Delete semantics: ON DELETE RESTRICT at the DB level. The route
 * layer surfaces FK violations as 409 with the consumer count so
 * the operator can decide whether to delete the dependent ingress
 * configs first.
 */

import { eq, and, count } from 'drizzle-orm';
import {
  clientOidcProviders,
  ingressAuthConfigs,
} from '../../db/schema.js';
import { encrypt, decrypt } from '../oidc/crypto.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import type { ClientOidcProvider } from '../../db/schema.js';

export interface ProviderInput {
  readonly name: string;
  readonly issuerUrl: string;
  readonly oauthClientId: string;
  /** Plaintext. Required on create; optional on update (omitted = keep). */
  readonly oauthClientSecret?: string;
  readonly authMethod?: 'client_secret_basic' | 'client_secret_post';
  readonly responseType?: 'code' | 'id_token' | 'code_id_token';
  readonly usePkce?: boolean;
  readonly defaultScopes?: string;
}

export interface ProviderResponse {
  readonly id: string;
  readonly name: string;
  readonly issuerUrl: string;
  readonly oauthClientId: string;
  readonly secretSet: boolean;
  readonly authMethod: 'client_secret_basic' | 'client_secret_post';
  readonly responseType: 'code' | 'id_token' | 'code_id_token';
  readonly usePkce: boolean;
  readonly defaultScopes: string;
  readonly consumerCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface Ctx {
  readonly encryptionKey: string;
}

function toResponse(row: ClientOidcProvider, consumerCount: number): ProviderResponse {
  return {
    id: row.id,
    name: row.name,
    issuerUrl: row.issuerUrl,
    oauthClientId: row.oauthClientId,
    secretSet: row.oauthClientSecretEncrypted.length > 0,
    authMethod: row.authMethod as ProviderResponse['authMethod'],
    responseType: row.responseType as ProviderResponse['responseType'],
    usePkce: row.usePkce,
    defaultScopes: row.defaultScopes,
    consumerCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function consumerCount(db: Database, providerId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(ingressAuthConfigs)
    .where(eq(ingressAuthConfigs.providerId, providerId));
  return Number(row?.n ?? 0);
}

export async function listProviders(
  db: Database,
  clientId: string,
): Promise<ReadonlyArray<ProviderResponse>> {
  const rows = await db
    .select()
    .from(clientOidcProviders)
    .where(eq(clientOidcProviders.clientId, clientId));
  // Per-row consumerCount: cheap join would be nicer but requires a
  // groupBy. Two-step: collect ids, fetch counts in one query.
  const idCounts = new Map<string, number>();
  if (rows.length > 0) {
    const counts = await db
      .select({ providerId: ingressAuthConfigs.providerId, n: count() })
      .from(ingressAuthConfigs)
      .groupBy(ingressAuthConfigs.providerId);
    for (const c of counts) {
      if (c.providerId) idCounts.set(c.providerId, Number(c.n));
    }
  }
  return rows.map((r) => toResponse(r, idCounts.get(r.id) ?? 0));
}

export async function getProvider(
  db: Database,
  clientId: string,
  id: string,
): Promise<ProviderResponse | null> {
  const [row] = await db
    .select()
    .from(clientOidcProviders)
    .where(and(eq(clientOidcProviders.id, id), eq(clientOidcProviders.clientId, clientId)));
  if (!row) return null;
  return toResponse(row, await consumerCount(db, id));
}

export async function createProvider(
  db: Database,
  ctx: Ctx,
  clientId: string,
  input: ProviderInput,
): Promise<ProviderResponse> {
  if (!input.oauthClientSecret) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'oauthClientSecret is required when creating a provider',
      400,
    );
  }
  const id = crypto.randomUUID();
  await db.insert(clientOidcProviders).values({
    id,
    clientId,
    name: input.name,
    issuerUrl: input.issuerUrl,
    oauthClientId: input.oauthClientId,
    oauthClientSecretEncrypted: encrypt(input.oauthClientSecret, ctx.encryptionKey),
    authMethod: input.authMethod ?? 'client_secret_basic',
    responseType: input.responseType ?? 'code',
    usePkce: input.usePkce ?? true,
    defaultScopes: input.defaultScopes ?? 'openid profile email',
  });
  const result = await getProvider(db, clientId, id);
  if (!result) throw new ApiError('INTERNAL', 'Provider missing after insert', 500);
  return result;
}

export async function updateProvider(
  db: Database,
  ctx: Ctx,
  clientId: string,
  id: string,
  input: Partial<ProviderInput>,
): Promise<ProviderResponse> {
  const existing = await getProvider(db, clientId, id);
  if (!existing) {
    throw new ApiError('NOT_FOUND', `Provider ${id} not found`, 404);
  }
  const set: Partial<typeof clientOidcProviders.$inferInsert> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.issuerUrl !== undefined) set.issuerUrl = input.issuerUrl;
  if (input.oauthClientId !== undefined) set.oauthClientId = input.oauthClientId;
  if (input.oauthClientSecret) {
    set.oauthClientSecretEncrypted = encrypt(input.oauthClientSecret, ctx.encryptionKey);
  }
  if (input.authMethod !== undefined) set.authMethod = input.authMethod;
  if (input.responseType !== undefined) set.responseType = input.responseType;
  if (input.usePkce !== undefined) set.usePkce = input.usePkce;
  if (input.defaultScopes !== undefined) set.defaultScopes = input.defaultScopes;
  if (Object.keys(set).length > 0) {
    await db
      .update(clientOidcProviders)
      .set(set)
      .where(and(eq(clientOidcProviders.id, id), eq(clientOidcProviders.clientId, clientId)));
  }
  const updated = await getProvider(db, clientId, id);
  if (!updated) throw new ApiError('INTERNAL', 'Provider missing after update', 500);
  return updated;
}

/**
 * Delete a provider. Surfaces a 409 with the consumer count when
 * any ingress_auth_config still references it (FK RESTRICT).
 */
export async function deleteProvider(
  db: Database,
  clientId: string,
  id: string,
): Promise<void> {
  const consumers = await consumerCount(db, id);
  if (consumers > 0) {
    throw new ApiError(
      'PROVIDER_IN_USE',
      `Provider is in use by ${consumers} ingress${consumers === 1 ? '' : 'es'}; ` +
        'disable auth on those ingresses before deleting the provider.',
      409,
      { consumers },
    );
  }
  await db
    .delete(clientOidcProviders)
    .where(and(eq(clientOidcProviders.id, id), eq(clientOidcProviders.clientId, clientId)));
}

/**
 * Decrypt the provider's client secret for reconciler consumption.
 */
export function decryptProviderSecret(
  row: ClientOidcProvider,
  encryptionKey: string,
): string {
  if (!row.oauthClientSecretEncrypted) return '';
  return decrypt(row.oauthClientSecretEncrypted, encryptionKey);
}
