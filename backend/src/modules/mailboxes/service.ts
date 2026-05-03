import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { eq, and } from 'drizzle-orm';
import { mailboxes, mailboxAccess, emailDomains, domains, users, clients } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { getClientMailboxLimit, getClientMailboxCount } from './limit.js';
import { notifyClientMailboxLimitReached } from '../notifications/events.js';
import {
  getJmapSession,
  createMailbox as jmapCreateMailbox,
  destroyPrincipal as jmapDestroyPrincipal,
  updatePrincipal as jmapUpdatePrincipal,
  type JmapAccountId,
} from '../stalwart-jmap/client.js';
import type { Database } from '../../db/index.js';
import type { CreateMailboxInput, UpdateMailboxInput } from '@k8s-hosting/api-contracts';
import type { FastifyInstance } from 'fastify';

const BCRYPT_ROUNDS = 12;

// ── Stalwart JMAP helpers ─────────────────────────────────────────────────────

/**
 * Resolve the Stalwart JMAP principals account ID.
 * Returns null if Stalwart is unreachable (unit tests, no mail stack).
 *
 * Security review M3 fix (2026-05-03): the cache used to be a permanent
 * non-null slot. If Stalwart was unreachable at first call we'd cache
 * the null path indirectly (every call re-tried, but a transient
 * recovery would never invalidate a cached account ID after Stalwart
 * was rebuilt with a different ID). Add a 5-minute TTL so a recovered
 * Stalwart is picked up without a platform-api restart.
 */
const JMAP_ACCOUNT_ID_CACHE_TTL_MS = 5 * 60 * 1000;
let _jmapAccountIdCache: JmapAccountId | null = null;
let _jmapAccountIdCachedAt = 0;

async function getJmapAccountId(): Promise<JmapAccountId | null> {
  if (_jmapAccountIdCache && Date.now() - _jmapAccountIdCachedAt < JMAP_ACCOUNT_ID_CACHE_TTL_MS) {
    return _jmapAccountIdCache;
  }
  try {
    const baseUrl = process.env.STALWART_MGMT_URL;
    const session = await getJmapSession(baseUrl, process.env);
    const id = session.primaryAccounts['urn:ietf:params:jmap:principals'];
    if (id) {
      _jmapAccountIdCache = id;
      _jmapAccountIdCachedAt = Date.now();
    }
    return id ?? null;
  } catch {
    return null;
  }
}

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
  stalwartPrincipalId: mailboxes.stalwartPrincipalId,
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

  // 3. Check mailbox count against plan-based client-total limit.
  //    Round-2 refactor: per-email-domain max_mailboxes is gone. We
  //    now cap TOTAL mailboxes for the client via the plan
  //    (hosting_plans.max_mailboxes) with an optional per-client
  //    override (clients.max_mailboxes_override). See limit.ts.
  const effective = await getClientMailboxLimit(db, clientId);
  const currentCount = await getClientMailboxCount(db, clientId);
  if (currentCount >= effective.limit) {
    // Fire-and-forget notification fan-out to all client_admin users.
    // We do NOT await the email delivery; we only await the DB insert
    // so the test path is deterministic. Any failure inside
    // notifyClientMailboxLimitReached is swallowed by notifyUser's
    // try/catch so this cannot mask the original ApiError.
    void notifyClientMailboxLimitReached(db, clientId, {
      limit: effective.limit,
      current: currentCount,
      source: effective.source,
    });
    throw new ApiError(
      'CLIENT_MAILBOX_LIMIT_REACHED',
      `Mailbox limit (${effective.limit}) reached for this account`,
      409,
      {
        limit: effective.limit,
        current: currentCount,
        source: effective.source,
      },
      'Upgrade your plan or request a per-client override from your administrator',
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

  // 5b. Provision mailbox in Stalwart via JMAP Principal/set.
  //     Code-review HIGH-1 fix (2026-05-03): use compensating cleanup on
  //     DB-write failure. The order is JMAP-first to avoid zombie DB
  //     rows; if the DB insert then fails (uniq race, conn loss), we
  //     destroy the just-created Stalwart principal so it doesn't
  //     accept mail with no platform-side owner. principals-sync would
  //     log it as orphan but never auto-cleans, so the compensating
  //     destroy is the actual recovery path.
  let stalwartPrincipalId: string | null = null;
  const accountId = await getJmapAccountId();
  if (accountId) {
    try {
      // Security review M1 (2026-05-03): cleartext password sent to
      // Stalwart over internal HTTP. Stalwart claims `$2b$` bcrypt
      // support but the staging E2E for hashed-secret login is still
      // pending; until that is verified, the fastest safe path is to
      // keep cleartext (Stalwart stores it as a hash internally; the
      // wire-time exposure is within the cluster, port 8080 not
      // externally reachable). Follow-up: pass `passwordHash` once
      // hashed-secret IMAP login is proven on staging.
      const principal = await jmapCreateMailbox({
        accountId,
        input: {
          type: 'individual',
          name: input.local_part,
          emails: [fullAddress],
          secrets: input.password ? [input.password] : undefined,
        },
        baseUrl: process.env.STALWART_MGMT_URL,
      });
      stalwartPrincipalId = principal.id ?? null;
    } catch (err) {
      throw new ApiError(
        'MAIL_SERVER_ERROR',
        `Stalwart mailbox provisioning failed: ${err instanceof Error ? err.message : String(err)}`,
        502,
        {},
        'Check Stalwart JMAP API reachability and logs',
      );
    }
  }

  // 6. Insert mailbox row — wrap in try/catch so we can roll back
  // the Stalwart principal on failure.
  const id = crypto.randomUUID();
  try {
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
      stalwartPrincipalId,
    });
  } catch (dbErr) {
    if (stalwartPrincipalId && accountId) {
      const { destroyPrincipal } = await import('../stalwart-jmap/client.js');
      await destroyPrincipal({
        accountId,
        id: stalwartPrincipalId,
        baseUrl: process.env.STALWART_MGMT_URL,
      }).catch((cleanupErr) => {
        console.warn(
          `[mailboxes] compensating Stalwart destroy failed for orphan ${stalwartPrincipalId}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
        );
      });
    }
    throw dbErr;
  }

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
  // Verify mailbox exists and belongs to client. Capture for later JMAP
  // sync so we don't burn a second SELECT on stalwartPrincipalId.
  const existingMailbox = await getMailbox(db, clientId, mailboxId);

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

  // Code-review H-3 fix (2026-05-03, second pass): propagate quota +
  // password to Stalwart so JMAP-side enforcement matches the platform
  // DB. Best-effort: if Stalwart is unreachable the platform DB is the
  // authoritative new state and principals-sync will eventually reconcile.
  // `status` is intentionally NOT synced because Stalwart has no
  // dedicated "suspended" flag on Principal — suspension is enforced at
  // the platform layer (auth/quota), and the legacy 0.15 sieve
  // suspension shim was retired in M11.
  if (input.quota_mb !== undefined || input.password !== undefined) {
    if (existingMailbox.stalwartPrincipalId) {
      const accountId = await getJmapAccountId();
      if (accountId) {
        const patch: Record<string, unknown> = {};
        if (input.quota_mb !== undefined) {
          // Stalwart `quota.storage` is bytes; the platform stores MB.
          patch['quota/storage'] = input.quota_mb * 1024 * 1024;
        }
        if (input.password !== undefined) {
          patch['secrets/0'] = input.password;
        }
        try {
          await jmapUpdatePrincipal({
            accountId,
            id: existingMailbox.stalwartPrincipalId,
            patch,
            baseUrl: process.env.STALWART_MGMT_URL,
          });
        } catch (err) {
          console.warn(
            `[mailboxes] updateMailbox: JMAP patch failed for '${mailboxId}': ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
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
  // Load full row so we have stalwartPrincipalId for JMAP cleanup.
  const [row] = await db
    .select({ id: mailboxes.id, clientId: mailboxes.clientId, fullAddress: mailboxes.fullAddress, stalwartPrincipalId: mailboxes.stalwartPrincipalId })
    .from(mailboxes)
    .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.clientId, clientId)));

  if (!row) throw mailboxNotFound(mailboxId);

  // Best-effort JMAP destroy — failure here is not fatal. The
  // principals-sync reconciler will catch any orphan in Stalwart.
  if (row.stalwartPrincipalId) {
    const accountId = await getJmapAccountId();
    if (accountId) {
      try {
        await jmapDestroyPrincipal({
          accountId,
          id: row.stalwartPrincipalId,
          baseUrl: process.env.STALWART_MGMT_URL,
        });
      } catch (err) {
        console.warn(
          `[mailboxes] deleteMailbox: JMAP destroy failed for '${row.fullAddress}' (${row.stalwartPrincipalId}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

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

  // Best-effort JMAP password update — keeps Stalwart in sync.
  // Non-fatal: the bcrypt hash update below is the authoritative write.
  const [row] = await db
    .select({ stalwartPrincipalId: mailboxes.stalwartPrincipalId })
    .from(mailboxes)
    .where(eq(mailboxes.id, mailboxId));

  if (row?.stalwartPrincipalId) {
    const accountId = await getJmapAccountId();
    if (accountId) {
      try {
        await jmapUpdatePrincipal({
          accountId,
          id: row.stalwartPrincipalId,
          patch: { 'secrets/0': newPassword },
          baseUrl: process.env.STALWART_MGMT_URL,
        });
      } catch (err) {
        console.warn(
          `[mailboxes] changeMailboxPassword: JMAP update failed for mailbox '${mailboxId}': ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

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

  // Phase 3.C.3: suspended / archived clients cannot access webmail.
  // Data is retained but all access paths (IMAP / POP / SMTP-auth /
  // webmail SSO / inbound SMTP delivery) are blocked. `pending` is
  // allowed so newly created clients can set up their first mailbox
  // before provisioning flips the status to `active`.
  const [client] = await db
    .select({ status: clients.status })
    .from(clients)
    .where(eq(clients.id, user.clientId));
  const clientStatus = client?.status;
  if (!client || (clientStatus !== 'active' && clientStatus !== 'pending')) {
    throw new ApiError(
      'CLIENT_SUSPENDED',
      'This client account is not currently active — webmail access is blocked',
      403,
      { client_id: user.clientId, status: clientStatus ?? 'unknown' },
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
  //   2. webmail-settings `default_webmail_url` (admin-configured via the
  //      Email Management page → Mail Server Settings → Webmail URL)
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
