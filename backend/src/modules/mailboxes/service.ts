import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { eq, and } from 'drizzle-orm';
import { mailLogger } from '../../shared/mail-logger.js';

const log = mailLogger().child({ module: 'mailboxes' });
import { mailboxes, mailboxAccess, emailDomains, domains, users, tenants, auditLogs } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { getTenantMailboxLimit, getTenantMailboxCount } from './limit.js';
import { notifyTenantMailboxLimitReached } from '../notifications/events.js';
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
  tenantId: mailboxes.tenantId,
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
  tenantId: string,
  emailDomainId: string,
  input: CreateMailboxInput,
) {
  // 1. Verify emailDomain exists and belongs to tenant
  const [emailDomain] = await db
    .select()
    .from(emailDomains)
    .where(and(eq(emailDomains.id, emailDomainId), eq(emailDomains.tenantId, tenantId)));

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

  // 3. Check mailbox count against plan-based tenant-total limit.
  //    Round-2 refactor: per-email-domain max_mailboxes is gone. We
  //    now cap TOTAL mailboxes for the tenant via the plan
  //    (hosting_plans.max_mailboxes) with an optional per-tenant
  //    override (tenants.max_mailboxes_override). See limit.ts.
  const effective = await getTenantMailboxLimit(db, tenantId);
  const currentCount = await getTenantMailboxCount(db, tenantId);
  if (currentCount >= effective.limit) {
    // Fire-and-forget notification fan-out to all tenant_admin users.
    // We do NOT await the email delivery; we only await the DB insert
    // so the test path is deterministic. Any failure inside
    // notifyTenantMailboxLimitReached is swallowed by notifyUser's
    // try/catch so this cannot mask the original ApiError.
    void notifyTenantMailboxLimitReached(db, tenantId, {
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
      'Upgrade your plan or request a per-tenant override from your administrator',
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
    // Stalwart 0.16: x:Account User payload requires `domainId` (the
    // server-side JMAP id of the parent x:Domain). The platform stores
    // that id on email_domains.stalwartDomainId after enableEmailForDomain
    // ran successfully. Without it, Stalwart can't bind the account to a
    // domain and rejects the create. If the email_domains row predates
    // the JMAP step (orphan), skip the JMAP create and let principals-
    // sync reconcile later when the domain has been provisioned.
    if (!emailDomain.stalwartDomainId) {
      log.warn({
        emailDomainId,
        domainName: domain.domainName,
      }, 'createMailbox: email_domain has no stalwartDomainId — skipping JMAP create (principals-sync will reconcile after domain is enabled)');
    } else {
      try {
        // Security review M1 (2026-05-03): cleartext password sent to
        // Stalwart over internal HTTP. Stalwart claims `$2b$` bcrypt
        // support but the staging E2E for hashed-secret login is still
        // pending; until that is verified, the fastest safe path is to
        // keep cleartext (Stalwart stores it as a hash internally; the
        // wire-time exposure is within the cluster, port 8080 not
        // externally reachable). Follow-up: pass `passwordHash` once
        // hashed-secret IMAP login is proven on staging.
        const { accountSet } = await import('../stalwart-jmap/client.js');
        const credentials: Record<string, unknown> = {};
        if (input.password) {
          credentials['0'] = {
            '@type': 'Password',
            secret: input.password,
            allowedIps: {},
            expiresAt: null,
          };
        }
        const xAccountResult = await accountSet({
          accountId,
          baseUrl: process.env.STALWART_MGMT_URL,
          request: {
            create: {
              'new-mailbox': {
                '@type': 'User',
                name: input.local_part,
                domainId: emailDomain.stalwartDomainId,
                ...(Object.keys(credentials).length > 0 ? { credentials } : {}),
                ...(input.display_name ? { description: input.display_name } : {}),
              },
            },
          },
        });
        const created = xAccountResult.created?.['new-mailbox'];
        const notCreated = xAccountResult.notCreated?.['new-mailbox'];
        if (notCreated) {
          throw new ApiError(
            'MAIL_SERVER_ERROR',
            `Stalwart x:Account/set rejected create: ${notCreated.description ?? notCreated.type}`,
            502,
            { type: notCreated.type, properties: notCreated.properties ?? null },
            'Check Stalwart JMAP API reachability and logs',
          );
        }
        const newId = (created as { id?: string } | undefined)?.id;
        stalwartPrincipalId = typeof newId === 'string' ? newId : null;
        // Suppress unused-warning on the legacy import — we still need
        // it for the compensating destroy path below, but this create
        // arm now bypasses the legacy `createMailbox` shim.
        void jmapCreateMailbox;
      } catch (err) {
        if (err instanceof ApiError) throw err;
        throw new ApiError(
          'MAIL_SERVER_ERROR',
          `Stalwart mailbox provisioning failed: ${err instanceof Error ? err.message : String(err)}`,
          502,
          {},
          'Check Stalwart JMAP API reachability and logs',
        );
      }
    }
  }

  // 6. Insert mailbox row — wrap in try/catch so we can roll back
  // the Stalwart principal on failure.
  const id = crypto.randomUUID();
  try {
    await db.insert(mailboxes).values({
      id,
      emailDomainId,
      tenantId,
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
        log.warn({
          stalwartPrincipalId,
          err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        }, 'compensating Stalwart destroy failed for orphan principal');
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
  tenantId: string,
  emailDomainId?: string,
) {
  const conditions = [eq(mailboxes.tenantId, tenantId)];
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
  tenantId: string,
  mailboxId: string,
) {
  const [record] = await db
    .select(mailboxColumns)
    .from(mailboxes)
    .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.tenantId, tenantId)));

  if (!record) throw mailboxNotFound(mailboxId);
  return record;
}

/**
 * Drift recovery (2026-05-06): JMAP-create an orphaned mailbox in Stalwart.
 *
 * Used by `updateMailbox` when the operator sets a new password on a
 * mailbox whose `stalwart_principal_id` is null — typically a leftover
 * from a `mail-pg` wipe where the platform DB row survived but Stalwart's
 * Account row was lost. Returns the new Stalwart principal id, or null
 * if Stalwart isn't reachable / not configured / the email-domain itself
 * is also orphan (no `stalwart_domain_id` to attach the account to).
 *
 * Best-effort by design: failures surface as the caller's logged warning,
 * not a transaction abort. The platform-DB bcrypt is updated independently.
 */
export async function syncOrphanMailboxToStalwart(
  db: Database,
  existingMailbox: { id: string; emailDomainId: string; localPart: string; displayName: string | null; quotaMb: number },
  plaintextPassword: string,
): Promise<string | null> {
  // Need the email_domain's stalwart_domain_id to attach the account to.
  const [emailDomain] = await db
    .select()
    .from(emailDomains)
    .where(eq(emailDomains.id, existingMailbox.emailDomainId));

  if (!emailDomain) {
    log.warn({ mailboxId: existingMailbox.id }, 'syncOrphanMailboxToStalwart: email_domain row missing');
    return null;
  }
  if (!emailDomain.stalwartDomainId) {
    log.warn({
      mailboxId: existingMailbox.id,
      emailDomainId: emailDomain.id,
    }, 'syncOrphanMailboxToStalwart: email_domain has no stalwartDomainId — cannot attach account. Re-run enableEmailForDomain first.');
    return null;
  }

  const accountId = await getJmapAccountId();
  if (!accountId) {
    log.info({ mailboxId: existingMailbox.id }, 'syncOrphanMailboxToStalwart: no JMAP account id (Stalwart unreachable?) — skipping');
    return null;
  }

  const { accountSet } = await import('../stalwart-jmap/client.js');
  const result = await accountSet({
    accountId,
    baseUrl: process.env.STALWART_MGMT_URL,
    request: {
      create: {
        'orphan-recovery': {
          '@type': 'User',
          name: existingMailbox.localPart,
          domainId: emailDomain.stalwartDomainId,
          credentials: {
            '0': {
              '@type': 'Password',
              secret: plaintextPassword,
              allowedIps: {},
              expiresAt: null,
            },
          },
          ...(existingMailbox.displayName ? { description: existingMailbox.displayName } : {}),
          // NOTE: deliberately NOT setting `quotas` at create time —
          // Stalwart 0.16's `quotas` field is `map<enum StorageQuota, ...>`
          // and JSON's lowercase keys (e.g. {"storage": ...}) don't match
          // the enum's TitleCase variant names. The existing createMailbox
          // path (above in this file) also omits quotas at create. To
          // sync quota into Stalwart after the orphan-recovery create
          // succeeds, the operator can issue a follow-up PATCH; that
          // path uses Principal/set with `quota/storage` (forward-slash
          // path patch, not enum-keyed map) which IS the documented
          // shape.
        },
      },
    },
  });

  const created = result.created?.['orphan-recovery'];
  const notCreated = result.notCreated?.['orphan-recovery'];
  if (notCreated) {
    throw new ApiError(
      'MAIL_SERVER_ERROR',
      `Stalwart x:Account/set rejected create during orphan recovery: ${notCreated.description ?? notCreated.type}`,
      502,
      { type: notCreated.type },
      'Likely the local_part collides with an existing account in Stalwart (created out-of-band). Inspect with stalwart-cli query Account.',
    );
  }
  const newId = (created as { id?: string } | undefined)?.id;
  return typeof newId === 'string' ? newId : null;
}

export async function updateMailbox(
  db: Database,
  tenantId: string,
  mailboxId: string,
  input: UpdateMailboxInput,
) {
  // Verify mailbox exists and belongs to client. Capture for later JMAP
  // sync so we don't burn a second SELECT on stalwartPrincipalId.
  const existingMailbox = await getMailbox(db, tenantId, mailboxId);

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
      // Synced mailbox: JMAP-PATCH the existing principal.
      const accountId = await getJmapAccountId();
      if (accountId) {
        const patch: Record<string, unknown> = {};
        if (input.quota_mb !== undefined) {
          // Stalwart `quota.storage` is bytes; the platform stores MB.
          patch['quota/storage'] = input.quota_mb * 1024 * 1024;
        }
        if (input.password !== undefined) {
          // Stalwart 0.16 path is credentials/0/secret (the new schema
          // uses `credentials` not `secrets`; secret is the inner field).
          // The old `secrets/0` path was a 0.15-era leftover that 0.16
          // rejects with "Invalid property" — verified empirically
          // 2026-05-06 against staging while validating orphan-recovery.
          patch['credentials/0/secret'] = input.password;
        }
        try {
          await jmapUpdatePrincipal({
            accountId,
            id: existingMailbox.stalwartPrincipalId,
            patch,
            baseUrl: process.env.STALWART_MGMT_URL,
          });
        } catch (err) {
          log.warn({
            mailboxId,
            err: err instanceof Error ? err.message : String(err),
          }, 'updateMailbox: JMAP patch failed (platform DB authoritative; principals-sync will reconcile)');
        }
      }
    } else if (input.password !== undefined) {
      // 2026-05-06: orphan-mailbox recovery path. The mailbox exists in
      // platform DB but has no Stalwart counterpart (typical post-mail-pg-
      // wipe state — see docs/02-operations/MAIL_PG_RESTORE.md for the
      // root cause). When the operator sets a NEW password, we have an
      // opportunity to JMAP-CREATE the mailbox in Stalwart with that
      // plaintext, since Stalwart cannot import pre-hashed credentials
      // (verified empirically 2026-05-06: any bcrypt secret passed to
      // Account/credentials/0/secret is treated as plaintext + re-hashed).
      //
      // This is the EXISTING "Reset password" UI flow doubling as drift
      // recovery — no new operator action required. Without it, every
      // operator-initiated password reset on an orphan mailbox just
      // updated the platform-DB bcrypt and Stalwart never saw the new
      // password. The mailbox stayed orphan forever and the user could
      // never log in.
      //
      // Best-effort: failures here surface as a logged warning + the
      // platform-DB bcrypt update still completes. The mailbox stays
      // orphan but the operator hasn't lost work — they can retry.
      try {
        const newPrincipalId = await syncOrphanMailboxToStalwart(db, existingMailbox, input.password);
        if (newPrincipalId) {
          await db
            .update(mailboxes)
            .set({ stalwartPrincipalId: newPrincipalId })
            .where(eq(mailboxes.id, mailboxId));
          log.info({
            mailboxId,
            fullAddress: existingMailbox.fullAddress,
            stalwartPrincipalId: newPrincipalId,
          }, 'updateMailbox: orphan mailbox recovered via JMAP-create on password set');
        }
      } catch (err) {
        log.warn({
          mailboxId,
          fullAddress: existingMailbox.fullAddress,
          err: err instanceof Error ? err.message : String(err),
        }, 'updateMailbox: orphan recovery failed (mailbox stays orphan; platform-DB bcrypt updated; operator can retry)');
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
  tenantId: string,
  mailboxId: string,
) {
  // Load full row so we have stalwartPrincipalId for JMAP cleanup.
  const [row] = await db
    .select({ id: mailboxes.id, tenantId: mailboxes.tenantId, fullAddress: mailboxes.fullAddress, stalwartPrincipalId: mailboxes.stalwartPrincipalId })
    .from(mailboxes)
    .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.tenantId, tenantId)));

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
        log.warn({
          fullAddress: row.fullAddress,
          stalwartPrincipalId: row.stalwartPrincipalId,
          err: err instanceof Error ? err.message : String(err),
        }, 'deleteMailbox: JMAP destroy failed (platform row deleted anyway; principals-sync will flag orphan)');
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
  tenantId: string,
  mailboxId: string,
  newPassword: string,
) {
  await getMailbox(db, tenantId, mailboxId);

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
        log.warn({
          mailboxId,
          err: err instanceof Error ? err.message : String(err),
        }, 'changeMailboxPassword: JMAP update failed (platform DB authoritative)');
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
  tenantId: string,
) {
  // Look up user to determine role
  const [user] = await db
    .select({ roleName: users.roleName, tenantId: users.tenantId })
    .from(users)
    .where(eq(users.id, userId));

  if (!user) {
    throw new ApiError('USER_NOT_FOUND', `User '${userId}' not found`, 404);
  }

  // tenant_admin gets ALL mailboxes for the tenant
  if (user.roleName === 'tenant_admin') {
    return db
      .select(mailboxColumns)
      .from(mailboxes)
      .where(eq(mailboxes.tenantId, tenantId));
  }

  // tenant_user gets only mailboxes assigned via mailbox_access
  const rows = await db
    .select({
      id: mailboxes.id,
      emailDomainId: mailboxes.emailDomainId,
      tenantId: mailboxes.tenantId,
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
    .where(and(eq(mailboxAccess.userId, userId), eq(mailboxes.tenantId, tenantId)));

  return rows;
}

interface GenerateWebmailTokenOptions {
  /**
   * Webmail engine to mint a token for. Defaults to `roundcube` to
   * preserve the historical behaviour for all callers that haven't
   * been updated yet. Phase 10 of the Bulwark integration roadmap
   * (ADR-039) wires `platform_config.default_webmail_engine` to flip
   * the default for new tenants.
   *
   * Bulwark tokens carry `iss`/`jti`/`tenant_id`/`actor_user_id` and
   * are verified by Bulwark's own `/api/auth/impersonate` route
   * (upstream issue #296 — landed in v1.6.7).
   */
  engine?: 'roundcube' | 'bulwark';
  /**
   * Tenant ID stamped on Bulwark JWTs for audit.
   *
   * SECURITY: callers MUST pass the tenantId derived from the
   * authenticated session (JWT `tenantId` claim), never a value from
   * request body. The audit row is rendered to operators verbatim.
   */
  tenantId?: string;
  /**
   * Actor user ID stamped on Bulwark JWTs for audit.
   *
   * SECURITY: callers MUST pass `user.sub` from the authenticated
   * session JWT, never a value from request body. A misrouted
   * caller-controlled value would spoof both the JWT `actor_user_id`
   * claim AND the audit-log row. Defaults to the authenticated
   * userId when omitted.
   */
  actorUserId?: string;
}

export async function generateWebmailToken(
  app: FastifyInstance,
  db: Database,
  userId: string,
  mailboxId: string,
  options?: GenerateWebmailTokenOptions,
) {
  // Look up user to get tenantId
  const [user] = await db
    .select({ tenantId: users.tenantId })
    .from(users)
    .where(eq(users.id, userId));

  if (!user?.tenantId) {
    throw new ApiError('USER_NOT_FOUND', 'User not found or has no tenant', 404);
  }

  // Phase 3.C.3: suspended / archived tenants cannot access webmail.
  // Data is retained but all access paths (IMAP / POP / SMTP-auth /
  // webmail SSO / inbound SMTP delivery) are blocked. `pending` is
  // allowed so newly created tenants can set up their first mailbox
  // before provisioning flips the status to `active`.
  const [tenant] = await db
    .select({ status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, user.tenantId));
  const tenantStatus = tenant?.status;
  if (!tenant || (tenantStatus !== 'active' && tenantStatus !== 'pending')) {
    throw new ApiError(
      'CLIENT_SUSPENDED',
      'This tenant account is not currently active — webmail access is blocked',
      403,
      { tenant_id: user.tenantId, status: tenantStatus ?? 'unknown' },
      'Contact your administrator to restore access',
    );
  }

  // Verify user has access to this mailbox
  const accessible = await getAccessibleMailboxes(db, userId, user.tenantId);
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
  // the owning tenant is active.
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
  // 2026-05-17 security fix (review #C1): per-engine HMAC keys to
  // eliminate cross-engine token replay. A Bulwark JWT contains an
  // `iss` claim that Roundcube's `jwt_auth.php` plugin ignores; under
  // the previous shared-key model a Bulwark token replayed at
  // `?_task=login&_jwt=` would have authenticated to Roundcube. The
  // engine-distinct keys make any such replay fail signature
  // verification on the OTHER engine.
  //
  // - Roundcube uses `WEBMAIL_JWT_SECRET` (mirror of
  //   roundcube-secrets/JWT_AUTH_SECRET)
  // - Bulwark uses `BULWARK_WEBMAIL_JWT_SECRET` (mirror of
  //   bulwark-secrets/BULWARK_JWT_AUTH_SECRET)
  // - For the legacy single-secret deployment, BULWARK_WEBMAIL_JWT_SECRET
  //   falls back to WEBMAIL_JWT_SECRET with a loud startup warning.
  //   That fallback is intentional ONLY for upgrade ergonomics — once
  //   the operator runs the next bootstrap.sh both Secrets get
  //   independent random values.
  // - In dev (JWT_SECRET unset, WEBMAIL_JWT_SECRET unset) we fall back
  //   to the API JWT_SECRET — that's the dev-only shortcut.

  // ─── Engine-aware JWT minting + URL composition ───────────────────
  //
  // Roundcube path  → JWT `{ mailbox, iat, exp }` + URL `?_task=login&_jwt=…`
  //                   Signed with WEBMAIL_JWT_SECRET. The Roundcube
  //                   jwt_auth plugin reads `?_jwt=` query.
  // Bulwark path    → JWT `{ iss, mailbox, jti, tenant_id, actor_user_id,
  //                          iat, exp }` + URL `/api/auth/impersonate?token=…`
  //                   Signed with BULWARK_WEBMAIL_JWT_SECRET (distinct
  //                   key — review fix C1 prevents cross-engine replay
  //                   where a Bulwark token would also pass Roundcube's
  //                   `jwt_auth.php` claim-set checks). Bulwark's native
  //                   route (upstream issue #296) enforces `iss`, `iat`,
  //                   single-use `jti`, lifetime ≤300s, and mailbox
  //                   without `%` or `:`.
  //
  // Engine resolution precedence:
  //   1. explicit caller override (options.engine)
  //   2. platform-wide `default_webmail_engine` setting
  //   3. hardcoded 'roundcube' (back-compat for fresh installs)
  let engine: 'roundcube' | 'bulwark';
  if (options?.engine) {
    engine = options.engine;
  } else {
    try {
      const { getDefaultWebmailEngine } = await import('../webmail-settings/service.js');
      engine = await getDefaultWebmailEngine(db);
    } catch {
      engine = 'roundcube';
    }
  }

  // Resolve per-engine HMAC key. Distinct keys eliminate cross-engine
  // token replay (Bulwark JWT spuriously passing Roundcube's claim
  // checks because both share the same secret).
  let webmailSecret: string | undefined;
  if (engine === 'bulwark') {
    webmailSecret = process.env.BULWARK_WEBMAIL_JWT_SECRET
      ?? process.env.WEBMAIL_JWT_SECRET
      ?? process.env.JWT_SECRET;
    if (!process.env.BULWARK_WEBMAIL_JWT_SECRET && process.env.WEBMAIL_JWT_SECRET) {
      // Legacy single-secret deployment — fall back to the Roundcube
      // key but warn. Operators upgrading from pre-2026-05-17 builds
      // hit this once on first deploy; bootstrap.sh's next run
      // provisions an independent BULWARK_JWT_AUTH_SECRET.
      app.log?.warn?.(
        'BULWARK_WEBMAIL_JWT_SECRET not set — falling back to WEBMAIL_JWT_SECRET. '
        + 'This enables cross-engine token replay. Run bootstrap.sh to provision '
        + 'independent keys for Roundcube + Bulwark.',
      );
    }
  } else {
    webmailSecret = process.env.WEBMAIL_JWT_SECRET ?? process.env.JWT_SECRET;
    if (!process.env.WEBMAIL_JWT_SECRET) {
      app.log?.warn?.(
        'WEBMAIL_JWT_SECRET not set — falling back to JWT_SECRET. '
        + 'For production, set WEBMAIL_JWT_SECRET to an independent random value.',
      );
    }
  }
  if (!webmailSecret || webmailSecret.length < 16) {
    app.log?.error?.({ engine }, 'Webmail JWT signing secret is not configured');
    throw new ApiError(
      'INTERNAL_ERROR',
      'Webmail JWT signing secret is not configured',
      500,
    );
  }

  const tenantId = options?.tenantId ?? user.tenantId;
  const actorUserId = options?.actorUserId ?? userId;

  let token: string;
  let webmailUrl: string;

  // Resolve the webmail base URL. Both engines share the same URL —
  // webmail.<apex> serves whichever engine is currently active (the
  // platform-webmail-ingress reconciler points it at roundcube OR
  // bulwark based on default_webmail_engine).
  //
  // Per-tenant Roundcube subdomains (webmail.<clientdomain>) are still
  // preferred for Roundcube so the cert in the address bar matches the
  // customer's domain. They do not apply to Bulwark, which is a single
  // platform-wide Deployment.
  let baseUrl: string | undefined;
  if (engine === 'roundcube') {
    try {
      const { getDerivedWebmailUrlForMailbox } = await import('../email-domains/service.js');
      baseUrl = await getDerivedWebmailUrlForMailbox(db, mailbox.id);
    } catch {
      // Email domain lookup failure is non-fatal — fall through to defaults
    }
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

  if (engine === 'bulwark') {
    // Bulwark impersonation JWT — verified by Bulwark's native
    // /api/auth/impersonate route (upstream issue #296). The route
    // requires HS256, iss/iat/exp/jti/mailbox claims, lifetime ≤300s,
    // and rejects `mailbox` claims containing `%` or `:` (defense
    // against caller smuggling master-user syntax into the claim).
    // Bulwark itself builds the `<mailbox>%<masterUser>` Basic auth
    // header server-side from BULWARK_STALWART_MASTER_USER /
    // BULWARK_STALWART_MASTER_PASSWORD envs.
    const jti = crypto.randomUUID();
    token = signWebmailJwt(
      {
        iss: 'platform-api/webmail',
        mailbox: mailbox.fullAddress,
        jti,
        tenant_id: tenantId,
        actor_user_id: actorUserId,
      },
      webmailSecret,
      // 30s window — short enough to limit blast radius on a leaked
      // Referer or access-log entry. Bulwark's own lifetime ceiling
      // is 300s; we sign tighter than the verifier accepts.
      30,
    );
    // Strip trailing slash so concat doesn't produce `//api/auth/impersonate`.
    // Next.js routes the doubled slash to the same handler but logs
    // are cleaner this way.
    const trimmed = baseUrl.replace(/\/+$/, '');
    webmailUrl = `${trimmed}/api/auth/impersonate?token=${encodeURIComponent(token)}`;
  } else {
    // Roundcube path — unchanged from before this commit.
    token = signWebmailJwt({ mailbox: mailbox.fullAddress }, webmailSecret, 30);
    const trimmed = baseUrl.replace(/\/+$/, '');
    webmailUrl = `${trimmed}/?_task=login&_jwt=${encodeURIComponent(token)}`;
  }

  // Audit-log every webmail token issuance. Bulwark impersonation is
  // a sensitive operation (operator gains full mailbox access without
  // entering the mailbox's password) so we record the actor, target,
  // engine, and issuance time. Failure to write the audit row MUST
  // NOT silently succeed the token — surface as INTERNAL_ERROR so the
  // operator retries instead of getting a token without an audit
  // trail.
  try {
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      tenantId,
      actionType: engine === 'bulwark' ? 'mail.webmail_impersonate' : 'mail.webmail_sso',
      resourceType: 'mailbox',
      resourceId: mailbox.id,
      actorId: actorUserId,
      actorType: 'user',
      httpMethod: 'POST',
      httpPath: '/api/v1/email/webmail-token',
      httpStatus: 200,
      changes: {
        engine,
        mailbox: mailbox.fullAddress,
        token_ttl_seconds: 30,
      },
    });
  } catch (err) {
    app.log?.error?.({ err, mailboxId: mailbox.id, engine }, 'webmail token audit write failed');
    throw new ApiError(
      'INTERNAL_ERROR',
      'Failed to record audit entry for webmail token',
      500,
    );
  }

  return {
    token,
    mailbox: mailbox.fullAddress,
    webmailUrl,
    engine,
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
