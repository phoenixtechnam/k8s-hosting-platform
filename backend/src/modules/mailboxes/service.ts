import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { eq, and, sql } from 'drizzle-orm';
import { mailboxes, mailboxAccess, emailDomains, domains, users, clients } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import type { CreateMailboxInput, UpdateMailboxInput } from '@k8s-hosting/api-contracts';
import type { FastifyInstance } from 'fastify';

const BCRYPT_ROUNDS = 12;

function mailboxNotFound(id: string): ApiError {
  return new ApiError('MAILBOX_NOT_FOUND', `Mailbox '${id}' not found`, 404, { mailbox_id: id }, 'Verify mailbox exists');
}

function emailDomainNotFound(id: string): ApiError {
  return new ApiError('EMAIL_DOMAIN_NOT_FOUND', `Email domain '${id}' not found`, 404, { email_domain_id: id }, 'Verify email domain exists');
}

/** Select columns that exclude passwordHash */
const mailboxColumns = {
  id: mailboxes.id,
  emailDomainId: mailboxes.emailDomainId,
  clientId: mailboxes.clientId,
  localPart: mailboxes.localPart,
  fullAddress: mailboxes.fullAddress,
  displayName: mailboxes.displayName,
  quotaMb: mailboxes.quotaMb,
  usedMb: mailboxes.usedMb,
  status: mailboxes.status,
  mailboxType: mailboxes.mailboxType,
  autoReply: mailboxes.autoReply,
  autoReplySubject: mailboxes.autoReplySubject,
  autoReplyBody: mailboxes.autoReplyBody,
  createdAt: mailboxes.createdAt,
  updatedAt: mailboxes.updatedAt,
} as const;

export async function createMailbox(
  db: Database,
  clientId: string,
  emailDomainId: string,
  input: CreateMailboxInput,
) {
  // 1. Verify emailDomain exists and belongs to client
  const [emailDomain] = await db
    .select()
    .from(emailDomains)
    .where(and(eq(emailDomains.id, emailDomainId), eq(emailDomains.clientId, clientId)));

  if (!emailDomain) {
    throw emailDomainNotFound(emailDomainId);
  }

  // 2. Get domain name via join
  const [domain] = await db
    .select({ domainName: domains.domainName })
    .from(domains)
    .where(eq(domains.id, emailDomain.domainId));

  if (!domain) {
    throw new ApiError('DOMAIN_NOT_FOUND', 'Associated domain not found', 404);
  }

  // 3. Check mailbox count against maxMailboxes limit
  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(mailboxes)
    .where(eq(mailboxes.emailDomainId, emailDomainId));

  const currentCount = Number(countResult?.count ?? 0);
  if (currentCount >= emailDomain.maxMailboxes) {
    throw new ApiError(
      'MAILBOX_LIMIT_REACHED',
      `Maximum mailbox limit (${emailDomain.maxMailboxes}) reached for this email domain`,
      409,
      { limit: emailDomain.maxMailboxes, current: currentCount },
      'Upgrade plan or remove unused mailboxes',
    );
  }

  // 4. Check fullAddress unique
  const fullAddress = `${input.local_part}@${domain.domainName}`;
  const [existing] = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(eq(mailboxes.fullAddress, fullAddress));

  if (existing) {
    throw new ApiError(
      'DUPLICATE_ENTRY',
      `Mailbox '${fullAddress}' already exists`,
      409,
      { resource: 'mailbox', address: fullAddress },
      'Use a different local part',
    );
  }

  // 5. Hash password
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  // 6. Insert mailbox row
  const id = crypto.randomUUID();
  await db.insert(mailboxes).values({
    id,
    emailDomainId,
    clientId,
    localPart: input.local_part,
    fullAddress,
    passwordHash,
    displayName: input.display_name ?? null,
    quotaMb: input.quota_mb,
    mailboxType: input.mailbox_type,
    status: 'active',
  });

  // 7. Return created mailbox without passwordHash
  const [created] = await db
    .select(mailboxColumns)
    .from(mailboxes)
    .where(eq(mailboxes.id, id));

  return created;
}

export async function listMailboxes(
  db: Database,
  clientId: string,
  emailDomainId?: string,
) {
  const conditions = [eq(mailboxes.clientId, clientId)];
  if (emailDomainId) {
    conditions.push(eq(mailboxes.emailDomainId, emailDomainId));
  }

  const rows = await db
    .select(mailboxColumns)
    .from(mailboxes)
    .where(and(...conditions));

  return rows;
}

export async function getMailbox(
  db: Database,
  clientId: string,
  mailboxId: string,
) {
  const [record] = await db
    .select(mailboxColumns)
    .from(mailboxes)
    .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.clientId, clientId)));

  if (!record) throw mailboxNotFound(mailboxId);
  return record;
}

export async function updateMailbox(
  db: Database,
  clientId: string,
  mailboxId: string,
  input: UpdateMailboxInput,
) {
  // Verify mailbox exists and belongs to client
  await getMailbox(db, clientId, mailboxId);

  const updateData: Record<string, unknown> = {};

  if (input.password !== undefined) {
    updateData.passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  }
  if (input.display_name !== undefined) {
    updateData.displayName = input.display_name;
  }
  if (input.quota_mb !== undefined) {
    updateData.quotaMb = input.quota_mb;
  }
  if (input.status !== undefined) {
    updateData.status = input.status;
  }
  if (input.auto_reply !== undefined) {
    updateData.autoReply = input.auto_reply ? 1 : 0;
  }
  if (input.auto_reply_subject !== undefined) {
    updateData.autoReplySubject = input.auto_reply_subject;
  }
  if (input.auto_reply_body !== undefined) {
    updateData.autoReplyBody = input.auto_reply_body;
  }

  if (Object.keys(updateData).length > 0) {
    await db.update(mailboxes).set(updateData).where(eq(mailboxes.id, mailboxId));
  }

  const [updated] = await db
    .select(mailboxColumns)
    .from(mailboxes)
    .where(eq(mailboxes.id, mailboxId));

  return updated;
}

export async function deleteMailbox(
  db: Database,
  clientId: string,
  mailboxId: string,
) {
  await getMailbox(db, clientId, mailboxId);

  // Delete access rows first
  await db.delete(mailboxAccess).where(eq(mailboxAccess.mailboxId, mailboxId));
  // Delete mailbox
  await db.delete(mailboxes).where(eq(mailboxes.id, mailboxId));
}

export async function changeMailboxPassword(
  db: Database,
  clientId: string,
  mailboxId: string,
  newPassword: string,
) {
  await getMailbox(db, clientId, mailboxId);

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await db.update(mailboxes).set({ passwordHash }).where(eq(mailboxes.id, mailboxId));

  const [updated] = await db
    .select(mailboxColumns)
    .from(mailboxes)
    .where(eq(mailboxes.id, mailboxId));

  return updated;
}

export async function grantMailboxAccess(
  db: Database,
  mailboxId: string,
  userId: string,
  accessLevel: 'full' | 'read_only',
) {
  const id = crypto.randomUUID();
  await db.insert(mailboxAccess).values({
    id,
    userId,
    mailboxId,
    accessLevel,
  });

  const [created] = await db
    .select()
    .from(mailboxAccess)
    .where(eq(mailboxAccess.id, id));

  return created;
}

export async function revokeMailboxAccess(
  db: Database,
  mailboxId: string,
  userId: string,
) {
  await db
    .delete(mailboxAccess)
    .where(and(eq(mailboxAccess.mailboxId, mailboxId), eq(mailboxAccess.userId, userId)));
}

export async function listMailboxAccess(
  db: Database,
  mailboxId: string,
) {
  const rows = await db
    .select({
      id: mailboxAccess.id,
      userId: mailboxAccess.userId,
      mailboxId: mailboxAccess.mailboxId,
      accessLevel: mailboxAccess.accessLevel,
      createdAt: mailboxAccess.createdAt,
      userEmail: users.email,
      userFullName: users.fullName,
    })
    .from(mailboxAccess)
    .innerJoin(users, eq(mailboxAccess.userId, users.id))
    .where(eq(mailboxAccess.mailboxId, mailboxId));

  return rows;
}

export async function getAccessibleMailboxes(
  db: Database,
  userId: string,
  clientId: string,
) {
  // Look up user to determine role
  const [user] = await db
    .select({ roleName: users.roleName, clientId: users.clientId })
    .from(users)
    .where(eq(users.id, userId));

  if (!user) {
    throw new ApiError('USER_NOT_FOUND', `User '${userId}' not found`, 404);
  }

  // client_admin gets ALL mailboxes for the client
  if (user.roleName === 'client_admin') {
    return db
      .select(mailboxColumns)
      .from(mailboxes)
      .where(eq(mailboxes.clientId, clientId));
  }

  // client_user gets only mailboxes assigned via mailbox_access
  const rows = await db
    .select({
      id: mailboxes.id,
      emailDomainId: mailboxes.emailDomainId,
      clientId: mailboxes.clientId,
      localPart: mailboxes.localPart,
      fullAddress: mailboxes.fullAddress,
      displayName: mailboxes.displayName,
      quotaMb: mailboxes.quotaMb,
      usedMb: mailboxes.usedMb,
      status: mailboxes.status,
      mailboxType: mailboxes.mailboxType,
      autoReply: mailboxes.autoReply,
      autoReplySubject: mailboxes.autoReplySubject,
      autoReplyBody: mailboxes.autoReplyBody,
      createdAt: mailboxes.createdAt,
      updatedAt: mailboxes.updatedAt,
    })
    .from(mailboxAccess)
    .innerJoin(mailboxes, eq(mailboxAccess.mailboxId, mailboxes.id))
    .where(and(eq(mailboxAccess.userId, userId), eq(mailboxes.clientId, clientId)));

  return rows;
}

export async function generateWebmailToken(
  app: FastifyInstance,
  db: Database,
  userId: string,
  mailboxId: string,
) {
  // Look up user to get clientId
  const [user] = await db
    .select({ clientId: users.clientId })
    .from(users)
    .where(eq(users.id, userId));

  if (!user?.clientId) {
    throw new ApiError('USER_NOT_FOUND', 'User not found or has no client', 404);
  }

  // Phase 3.C.3: suspended clients cannot access webmail at all,
  // even if individual mailboxes are still marked active. The data
  // is retained but all access paths (IMAP / POP / SMTP-auth /
  // webmail SSO / inbound SMTP delivery) are blocked.
  const [client] = await db
    .select({ status: clients.status })
    .from(clients)
    .where(eq(clients.id, user.clientId));
  if (!client || client.status !== 'active') {
    throw new ApiError(
      'CLIENT_SUSPENDED',
      'This client account is suspended — webmail access is blocked',
      403,
      { client_id: user.clientId, status: client?.status ?? 'unknown' },
      'Contact your administrator to restore access',
    );
  }

  // Verify user has access to this mailbox
  const accessible = await getAccessibleMailboxes(db, userId, user.clientId);
  const mailbox = accessible.find((m) => m.id === mailboxId);

  if (!mailbox) {
    throw new ApiError(
      'MAILBOX_ACCESS_DENIED',
      'You do not have access to this mailbox',
      403,
      { mailbox_id: mailboxId },
      'Request access from your administrator',
    );
  }

  // Phase 3.C.3: also check the individual mailbox status. Accessing a
  // mailbox's webmail when the mailbox is suspended is blocked even if
  // the owning client is active.
  const [mbRow] = await db
    .select({ status: mailboxes.status })
    .from(mailboxes)
    .where(eq(mailboxes.id, mailboxId));
  if (mbRow && mbRow.status !== 'active') {
    throw new ApiError(
      'MAILBOX_SUSPENDED',
      'This mailbox is suspended',
      403,
      { mailbox_id: mailboxId, status: mbRow.status },
    );
  }

  // Sign a short-lived JWT for webmail SSO. Phase 2b: 30s expiry — long
  // enough for the redirect chain, short enough to minimise risk if the URL
  // leaks via logs, browser history, or Referer headers.
  //
  // We sign this with a DEDICATED secret (WEBMAIL_JWT_SECRET) that is
  // independent of the API JWT secret, so a leak of one secret cannot forge
  // the other class of token. Falls back to the API JWT_SECRET when the
  // dedicated secret is not configured, which matches current dev overlays;
  // production overlays MUST set both to independent random values.
  const webmailSecret = process.env.WEBMAIL_JWT_SECRET ?? process.env.JWT_SECRET;
  if (!webmailSecret || webmailSecret.length < 16) {
    app.log?.error?.('Webmail JWT signing secret is not configured');
    throw new ApiError(
      'INTERNAL_ERROR',
      'Webmail JWT signing secret is not configured',
      500,
    );
  }
  if (!process.env.WEBMAIL_JWT_SECRET) {
    app.log?.warn?.(
      'WEBMAIL_JWT_SECRET not set — falling back to JWT_SECRET. '
      + 'For production, set WEBMAIL_JWT_SECRET to an independent random value.',
    );
  }
  const token = signWebmailJwt({ mailbox: mailbox.fullAddress }, webmailSecret, 30);

  // Resolve the webmail base URL. Phase 2c.5 introduced derived
  // webmail Ingresses: every email_domain with webmail_enabled=true
  // gets a webmail.<domain> Ingress in the client's namespace. So the
  // lookup order is:
  //
  //   1. mailbox → email_domain → domain → if webmail_enabled, use
  //      `https://webmail.<domain.domainName>`
  //   2. webmail-settings `default_webmail_url` (admin-configured)
  //   3. WEBMAIL_URL env var (legacy / container-env override)
  //   4. Hardcoded fallback `https://webmail.example.com`
  //
  // Lazy imports to avoid circular dependencies.
  let baseUrl: string | undefined;
  try {
    const { getDerivedWebmailUrlForMailbox } = await import('../email-domains/service.js');
    baseUrl = await getDerivedWebmailUrlForMailbox(db, mailbox.id);
  } catch {
    // Email domain lookup failure is non-fatal — fall through to defaults
  }
  if (!baseUrl) {
    try {
      const { getDefaultWebmailUrl } = await import('../webmail-settings/service.js');
      baseUrl = await getDefaultWebmailUrl(db);
    } catch {
      baseUrl = undefined;
    }
  }
  baseUrl = baseUrl ?? process.env.WEBMAIL_URL ?? 'https://webmail.example.com';

  // The SSO URL points at Roundcube's login action with the JWT as a
  // query parameter. The jwt_auth plugin's `startup` hook intercepts it
  // before the login form renders.
  const webmailUrl = `${baseUrl}/?_task=login&_jwt=${encodeURIComponent(token)}`;

  return {
    token,
    mailbox: mailbox.fullAddress,
    webmailUrl,
  };
}

/**
 * Sign a minimal HS256 JWT without pulling in @fastify/jwt (which is bound
 * to the API secret at plugin registration time). Only used by webmail SSO.
 *
 * Exported for unit tests.
 */
export function signWebmailJwt(
  payload: Record<string, unknown>,
  secret: string,
  expiresInSeconds: number,
): string {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSeconds,
  };
  const headerB64 = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payloadB64 = base64urlEncode(JSON.stringify(fullPayload));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  const sigB64 = base64urlEncode(signature);
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

function base64urlEncode(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
