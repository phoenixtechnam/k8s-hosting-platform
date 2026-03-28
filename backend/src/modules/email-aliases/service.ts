import { eq, and } from 'drizzle-orm';
import { emailAliases, emailDomains, mailboxes, domains } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import type { CreateEmailAliasInput, UpdateEmailAliasInput } from '@k8s-hosting/api-contracts';

export async function createAlias(
  db: Database,
  clientId: string,
  emailDomainId: string,
  input: CreateEmailAliasInput,
) {
  // Verify emailDomain exists and belongs to client
  const [emailDomain] = await db
    .select()
    .from(emailDomains)
    .where(and(eq(emailDomains.id, emailDomainId), eq(emailDomains.clientId, clientId)));

  if (!emailDomain) {
    throw new ApiError('EMAIL_DOMAIN_NOT_FOUND', `Email domain '${emailDomainId}' not found`, 404);
  }

  // Get the parent domain to verify source_address domain matches
  const [parentDomain] = await db
    .select()
    .from(domains)
    .where(eq(domains.id, emailDomain.domainId));

  if (!parentDomain) {
    throw new ApiError('DOMAIN_NOT_FOUND', 'Parent domain not found for email domain', 404);
  }

  const sourceDomain = input.source_address.split('@')[1];
  if (sourceDomain !== parentDomain.domainName) {
    throw new ApiError(
      'DOMAIN_MISMATCH',
      `Source address domain '${sourceDomain}' does not match email domain '${parentDomain.domainName}'`,
      400,
    );
  }

  // Check source_address not already taken as alias
  const [existingAlias] = await db
    .select()
    .from(emailAliases)
    .where(eq(emailAliases.sourceAddress, input.source_address));

  if (existingAlias) {
    throw new ApiError('DUPLICATE_ENTRY', `Alias '${input.source_address}' already exists`, 409);
  }

  // Check source_address not already taken as mailbox
  const [existingMailbox] = await db
    .select()
    .from(mailboxes)
    .where(eq(mailboxes.fullAddress, input.source_address));

  if (existingMailbox) {
    throw new ApiError('DUPLICATE_ENTRY', `Address '${input.source_address}' is already used by a mailbox`, 409);
  }

  const id = crypto.randomUUID();
  await db.insert(emailAliases).values({
    id,
    emailDomainId,
    clientId,
    sourceAddress: input.source_address,
    destinationAddresses: input.destination_addresses,
    enabled: 1,
  });

  const [created] = await db.select().from(emailAliases).where(eq(emailAliases.id, id));
  return created;
}

export async function listAliases(db: Database, clientId: string, emailDomainId?: string) {
  const conditions = [eq(emailAliases.clientId, clientId)];
  if (emailDomainId) {
    conditions.push(eq(emailAliases.emailDomainId, emailDomainId));
  }
  return db.select().from(emailAliases).where(and(...conditions));
}

export async function updateAlias(
  db: Database,
  clientId: string,
  aliasId: string,
  input: UpdateEmailAliasInput,
) {
  const [alias] = await db
    .select()
    .from(emailAliases)
    .where(and(eq(emailAliases.id, aliasId), eq(emailAliases.clientId, clientId)));

  if (!alias) {
    throw new ApiError('EMAIL_ALIAS_NOT_FOUND', `Email alias '${aliasId}' not found`, 404);
  }

  const updateValues: Record<string, unknown> = {};
  if (input.destination_addresses !== undefined) {
    updateValues.destinationAddresses = input.destination_addresses;
  }
  if (input.enabled !== undefined) {
    updateValues.enabled = input.enabled ? 1 : 0;
  }

  if (Object.keys(updateValues).length > 0) {
    await db.update(emailAliases).set(updateValues).where(eq(emailAliases.id, aliasId));
  }

  const [updated] = await db.select().from(emailAliases).where(eq(emailAliases.id, aliasId));
  return updated;
}

export async function deleteAlias(db: Database, clientId: string, aliasId: string) {
  const [alias] = await db
    .select()
    .from(emailAliases)
    .where(and(eq(emailAliases.id, aliasId), eq(emailAliases.clientId, clientId)));

  if (!alias) {
    throw new ApiError('EMAIL_ALIAS_NOT_FOUND', `Email alias '${aliasId}' not found`, 404);
  }

  await db.delete(emailAliases).where(eq(emailAliases.id, aliasId));
}
