import { eq, and, sql } from 'drizzle-orm';
import { emailDomains, domains, mailboxes } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { generateDkimKeyPair } from './dkim.js';
import { encrypt } from '../oidc/crypto.js';
import { provisionEmailDns, deprovisionEmailDns } from './dns-provisioning.js';
import type { Database } from '../../db/index.js';
import type { EnableEmailDomainInput, UpdateEmailDomainInput } from '@k8s-hosting/api-contracts';

async function verifyDomainOwnership(db: Database, clientId: string, domainId: string) {
  const [domain] = await db
    .select()
    .from(domains)
    .where(and(eq(domains.id, domainId), eq(domains.clientId, clientId)));

  if (!domain) {
    throw new ApiError('DOMAIN_NOT_FOUND', `Domain '${domainId}' not found for client`, 404);
  }
  return domain;
}

export async function enableEmailForDomain(
  db: Database,
  clientId: string,
  domainId: string,
  input: EnableEmailDomainInput,
  encryptionKey: string,
) {
  const domain = await verifyDomainOwnership(db, clientId, domainId);

  // Check if already enabled (idempotent)
  const [existing] = await db
    .select()
    .from(emailDomains)
    .where(eq(emailDomains.domainId, domainId));

  if (existing) {
    return { ...existing, domainName: domain.domainName };
  }

  // Generate DKIM key pair
  const { privateKey, publicKey } = generateDkimKeyPair();
  const dkimPrivateKeyEncrypted = encrypt(privateKey, encryptionKey);
  const dkimSelector = 'default';

  const id = crypto.randomUUID();

  await db.insert(emailDomains).values({
    id,
    domainId,
    clientId,
    enabled: 1,
    dkimSelector,
    dkimPrivateKeyEncrypted,
    dkimPublicKey: publicKey,
    maxMailboxes: input.max_mailboxes ?? 50,
    maxQuotaMb: input.max_quota_mb ?? 10240,
    catchAllAddress: input.catch_all_address ?? null,
  });

  // Provision DNS records
  await provisionEmailDns(db, domainId, domain.domainName, dkimSelector, publicKey, encryptionKey);

  const [created] = await db
    .select()
    .from(emailDomains)
    .where(eq(emailDomains.id, id));

  return { ...created, domainName: domain.domainName };
}

export async function disableEmailForDomain(
  db: Database,
  clientId: string,
  domainId: string,
) {
  await verifyDomainOwnership(db, clientId, domainId);

  const [existing] = await db
    .select()
    .from(emailDomains)
    .where(and(eq(emailDomains.domainId, domainId), eq(emailDomains.clientId, clientId)));

  if (!existing) {
    throw new ApiError('EMAIL_DOMAIN_NOT_FOUND', `Email is not enabled for domain '${domainId}'`, 404);
  }

  await db.delete(emailDomains).where(eq(emailDomains.id, existing.id));
  await deprovisionEmailDns(db, domainId);
}

export async function getEmailDomain(
  db: Database,
  clientId: string,
  domainId: string,
) {
  await verifyDomainOwnership(db, clientId, domainId);

  const [emailDomain] = await db
    .select({
      id: emailDomains.id,
      domainId: emailDomains.domainId,
      clientId: emailDomains.clientId,
      domainName: domains.domainName,
      enabled: emailDomains.enabled,
      dkimSelector: emailDomains.dkimSelector,
      dkimPublicKey: emailDomains.dkimPublicKey,
      maxMailboxes: emailDomains.maxMailboxes,
      maxQuotaMb: emailDomains.maxQuotaMb,
      catchAllAddress: emailDomains.catchAllAddress,
      mxProvisioned: emailDomains.mxProvisioned,
      spfProvisioned: emailDomains.spfProvisioned,
      dkimProvisioned: emailDomains.dkimProvisioned,
      dmarcProvisioned: emailDomains.dmarcProvisioned,
      spamThresholdJunk: emailDomains.spamThresholdJunk,
      spamThresholdReject: emailDomains.spamThresholdReject,
      createdAt: emailDomains.createdAt,
      updatedAt: emailDomains.updatedAt,
    })
    .from(emailDomains)
    .innerJoin(domains, eq(emailDomains.domainId, domains.id))
    .where(and(eq(emailDomains.domainId, domainId), eq(emailDomains.clientId, clientId)));

  if (!emailDomain) {
    throw new ApiError('EMAIL_DOMAIN_NOT_FOUND', `Email is not enabled for domain '${domainId}'`, 404);
  }

  // Get mailbox count
  const [mailboxCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(mailboxes)
    .where(eq(mailboxes.emailDomainId, emailDomain.id));

  return { ...emailDomain, mailboxCount: mailboxCount?.count ?? 0 };
}

export async function listEmailDomains(
  db: Database,
  clientId: string,
) {
  const results = await db
    .select({
      id: emailDomains.id,
      domainId: emailDomains.domainId,
      clientId: emailDomains.clientId,
      domainName: domains.domainName,
      enabled: emailDomains.enabled,
      dkimSelector: emailDomains.dkimSelector,
      dkimPublicKey: emailDomains.dkimPublicKey,
      maxMailboxes: emailDomains.maxMailboxes,
      maxQuotaMb: emailDomains.maxQuotaMb,
      catchAllAddress: emailDomains.catchAllAddress,
      mxProvisioned: emailDomains.mxProvisioned,
      spfProvisioned: emailDomains.spfProvisioned,
      dkimProvisioned: emailDomains.dkimProvisioned,
      dmarcProvisioned: emailDomains.dmarcProvisioned,
      spamThresholdJunk: emailDomains.spamThresholdJunk,
      spamThresholdReject: emailDomains.spamThresholdReject,
      createdAt: emailDomains.createdAt,
      updatedAt: emailDomains.updatedAt,
      mailboxCount: sql<number>`(SELECT count(*) FROM mailboxes WHERE mailboxes.email_domain_id = ${emailDomains.id})`,
    })
    .from(emailDomains)
    .innerJoin(domains, eq(emailDomains.domainId, domains.id))
    .where(eq(emailDomains.clientId, clientId));

  return results;
}

export async function listAllEmailDomains(db: Database) {
  const results = await db
    .select({
      id: emailDomains.id,
      domainId: emailDomains.domainId,
      clientId: emailDomains.clientId,
      domainName: domains.domainName,
      enabled: emailDomains.enabled,
      dkimSelector: emailDomains.dkimSelector,
      dkimPublicKey: emailDomains.dkimPublicKey,
      maxMailboxes: emailDomains.maxMailboxes,
      maxQuotaMb: emailDomains.maxQuotaMb,
      catchAllAddress: emailDomains.catchAllAddress,
      mxProvisioned: emailDomains.mxProvisioned,
      spfProvisioned: emailDomains.spfProvisioned,
      dkimProvisioned: emailDomains.dkimProvisioned,
      dmarcProvisioned: emailDomains.dmarcProvisioned,
      spamThresholdJunk: emailDomains.spamThresholdJunk,
      spamThresholdReject: emailDomains.spamThresholdReject,
      createdAt: emailDomains.createdAt,
      updatedAt: emailDomains.updatedAt,
      mailboxCount: sql<number>`(SELECT count(*) FROM mailboxes WHERE mailboxes.email_domain_id = ${emailDomains.id})`,
    })
    .from(emailDomains)
    .innerJoin(domains, eq(emailDomains.domainId, domains.id));

  return results;
}

export async function updateEmailDomain(
  db: Database,
  clientId: string,
  domainId: string,
  input: UpdateEmailDomainInput,
) {
  await verifyDomainOwnership(db, clientId, domainId);

  const [existing] = await db
    .select()
    .from(emailDomains)
    .where(and(eq(emailDomains.domainId, domainId), eq(emailDomains.clientId, clientId)));

  if (!existing) {
    throw new ApiError('EMAIL_DOMAIN_NOT_FOUND', `Email is not enabled for domain '${domainId}'`, 404);
  }

  const updateValues: Record<string, unknown> = {};
  if (input.enabled !== undefined) updateValues.enabled = input.enabled ? 1 : 0;
  if (input.max_mailboxes !== undefined) updateValues.maxMailboxes = input.max_mailboxes;
  if (input.max_quota_mb !== undefined) updateValues.maxQuotaMb = input.max_quota_mb;
  if (input.catch_all_address !== undefined) updateValues.catchAllAddress = input.catch_all_address;
  if (input.spam_threshold_junk !== undefined) updateValues.spamThresholdJunk = String(input.spam_threshold_junk);
  if (input.spam_threshold_reject !== undefined) updateValues.spamThresholdReject = String(input.spam_threshold_reject);

  if (Object.keys(updateValues).length > 0) {
    await db
      .update(emailDomains)
      .set(updateValues)
      .where(eq(emailDomains.id, existing.id));
  }

  const [updated] = await db
    .select()
    .from(emailDomains)
    .where(eq(emailDomains.id, existing.id));

  return updated;
}
