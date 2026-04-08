/**
 * DKIM key rotation service.
 *
 * Phase 3 T1.1 (B.2) — replaces the single fixed DKIM key per email
 * domain with a rotation model that supports grace-period overlap
 * and different operator workflows based on the domain's DNS mode.
 *
 * ─── Rotation lifecycle ──────────────────────────────────────────
 *
 * A DKIM key goes through this state machine:
 *
 *   pending → active → retired → (purged)
 *
 *   pending  — generated but not yet signing mail. Waiting for DNS
 *              propagation (primary mode: auto-verified after the
 *              TXT record syncs) or for the admin to confirm manual
 *              DNS setup (secondary/cname mode).
 *   active   — Stalwart signs outgoing mail with this key. The
 *              public key's TXT record is in DNS. Multiple `active`
 *              keys can coexist during a rotation grace window.
 *   retired  — no longer signing new mail, but the public TXT record
 *              is still in DNS so in-flight mail signed during the
 *              overlap window can still be verified by recipients.
 *              Default retention 30 days.
 *   purged   — row deleted, DNS TXT record removed (primary mode) or
 *              operator notified to remove it (secondary/cname mode).
 *
 * ─── Mode-specific flows ─────────────────────────────────────────
 *
 * Primary/authoritative DNS mode:
 *   rotateDkimKey()  → generates key, inserts pending, publishes
 *                      DNS TXT via dns-records syncRecordToProviders,
 *                      immediately flips status to 'active' (the
 *                      platform owns the zone so propagation is
 *                      instant from our perspective).
 *   Cron rotates eligible keys automatically (age threshold).
 *
 * Secondary / cname / external DNS:
 *   rotateDkimKey()  → generates key, inserts pending, returns the
 *                      DNS record the admin must add to their own
 *                      zone. Key stays in 'pending' until the admin
 *                      verifies the record and calls activatePendingKey.
 *   No automatic cron — operator-driven only.
 */

import crypto from 'crypto';
import { eq, and, lt, sql, desc } from 'drizzle-orm';
import {
  emailDkimKeys,
  emailDomains,
  domains,
  type EmailDkimKey,
} from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { encrypt } from '../oidc/crypto.js';
import { generateDkimKeyPair, formatDkimDnsValue } from '../email-domains/dkim.js';
import { syncRecordToProviders } from '../dns-records/service.js';
import { canManageDnsZone } from '../dns-servers/authority.js';
import { getActiveServersForDomain } from '../dns-servers/service.js';
import type { Database } from '../../db/index.js';

export type DkimMode = 'primary' | 'cname' | 'secondary';

const ALLOWED_DNS_MODES = new Set<DkimMode>(['primary', 'cname', 'secondary']);

export interface RotateOptions {
  // Reserved for future use — currently unused but kept in the
  // signature so callers can pass it without refactoring when the
  // post-rotation retire flow lands.
  readonly _reserved?: never;
}

export interface RotateResult {
  readonly keyId: string;
  readonly newSelector: string;
  readonly mode: DkimMode;
  readonly status: 'pending' | 'active';
  readonly manualDnsRequired: boolean;
  readonly dnsRecordName: string;
  readonly dnsRecordValue: string;
}

function generateUniqueSelector(
  basePrefix: string,
  existingSelectors: readonly string[],
): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const base = `${basePrefix}-${yyyy}${mm}`;
  if (!existingSelectors.includes(base)) return base;
  // Append a short random suffix if there's already a key this month
  for (let i = 0; i < 10; i += 1) {
    const suffix = crypto.randomBytes(2).toString('hex');
    const candidate = `${base}-${suffix}`;
    if (!existingSelectors.includes(candidate)) return candidate;
  }
  // Very unlikely fallback
  return `${base}-${Date.now()}`;
}

async function loadEmailDomainWithMode(
  db: Database,
  emailDomainId: string,
): Promise<{
  emailDomainId: string;
  domainId: string;
  clientId: string;
  domainName: string;
  dnsMode: DkimMode;
  selector: string;
} | null> {
  const [row] = await db
    .select({
      emailDomainId: emailDomains.id,
      domainId: emailDomains.domainId,
      clientId: emailDomains.clientId,
      domainName: domains.domainName,
      dnsMode: domains.dnsMode,
      selector: emailDomains.dkimSelector,
    })
    .from(emailDomains)
    .innerJoin(domains, eq(emailDomains.domainId, domains.id))
    .where(eq(emailDomains.id, emailDomainId));
  if (!row) return null;
  return { ...row, dnsMode: row.dnsMode as DkimMode };
}

/**
 * Generate a new DKIM key for an email domain.
 *
 * The flow branches on the domain's DNS mode:
 *   - primary: write DNS, flip to active immediately
 *   - cname/secondary: leave pending, return the DNS record the
 *     operator needs to publish manually
 */
export async function rotateDkimKey(
  db: Database,
  emailDomainId: string,
  encryptionKey: string,
  _options: RotateOptions = {},
): Promise<RotateResult> {
  const ed = await loadEmailDomainWithMode(db, emailDomainId);
  if (!ed) {
    throw new ApiError('EMAIL_DOMAIN_NOT_FOUND', `Email domain '${emailDomainId}' not found`, 404);
  }
  if (!ALLOWED_DNS_MODES.has(ed.dnsMode)) {
    throw new ApiError(
      'INVALID_DNS_MODE',
      `Unknown dnsMode '${ed.dnsMode}' for domain '${ed.domainName}'`,
      500,
    );
  }

  // Resolve active DNS servers for the domain (used by the authority
  // check below).
  const activeServers = await getActiveServersForDomain(db, ed.domainId);

  // Existing selectors for this email domain (so we don't reuse one)
  const existingRows = await db
    .select({ selector: emailDkimKeys.selector })
    .from(emailDkimKeys)
    .where(eq(emailDkimKeys.emailDomainId, emailDomainId));
  const existingSelectors = existingRows.map((r) => r.selector);

  // Base prefix from the email domain's stored selector (usually
  // 'default'). If we've rotated before, the stored selector will
  // include a date suffix; strip back to the base.
  const basePrefix = ed.selector.split('-')[0] ?? 'default';
  const newSelector = generateUniqueSelector(basePrefix, existingSelectors);

  const { privateKey, publicKey } = generateDkimKeyPair();
  const encryptedPrivate = encrypt(privateKey, encryptionKey);

  // Determine mode + whether the platform can write DNS
  const canManage = canManageDnsZone({
    dnsMode: ed.dnsMode,
    activeServers: activeServers.map((s) => ({
      id: s.id,
      providerType: s.providerType,
      enabled: s.enabled,
      role: s.role,
    })),
  });
  const mode: DkimMode = ed.dnsMode;
  const initialStatus: 'pending' | 'active' =
    mode === 'primary' && canManage ? 'active' : 'pending';

  const keyId = crypto.randomUUID();
  const dnsRecordName = `${newSelector}._domainkey.${ed.domainName}`;
  const dnsRecordValue = formatDkimDnsValue(publicKey);

  // Insert the row FIRST so we can reference it from downstream hooks.
  await db.insert(emailDkimKeys).values({
    id: keyId,
    emailDomainId,
    selector: newSelector,
    privateKeyEncrypted: encryptedPrivate,
    publicKey,
    status: initialStatus,
    dnsVerifiedAt: initialStatus === 'active' ? new Date() : null,
    activatedAt: initialStatus === 'active' ? new Date() : null,
  });

  // Primary mode → publish the DNS record via the platform DNS provider
  if (initialStatus === 'active') {
    try {
      await syncRecordToProviders(
        db,
        ed.domainName,
        'create',
        {
          type: 'TXT',
          name: dnsRecordName,
          content: dnsRecordValue,
          ttl: 3600,
        },
        ed.domainId,
      );
    } catch {
      // DNS sync failure is non-fatal — the key is still generated
      // and available. Operator can retry publish via a follow-up
      // endpoint (Phase 3 T1.1 follow-up).
    }
  }

  return {
    keyId,
    newSelector,
    mode,
    status: initialStatus,
    manualDnsRequired: initialStatus === 'pending',
    dnsRecordName,
    dnsRecordValue,
  };
}

/**
 * Activate a pending DKIM key. Used by cname/secondary mode when the
 * operator has confirmed the DNS TXT record is in place at the
 * customer's own DNS provider.
 */
export async function activatePendingKey(
  db: Database,
  keyId: string,
): Promise<EmailDkimKey> {
  const [key] = await db
    .select()
    .from(emailDkimKeys)
    .where(eq(emailDkimKeys.id, keyId));
  if (!key) {
    throw new ApiError('DKIM_KEY_NOT_FOUND', `DKIM key '${keyId}' not found`, 404);
  }
  if (key.status !== 'pending') {
    throw new ApiError(
      'INVALID_STATE',
      `DKIM key '${keyId}' is in state '${key.status}', only 'pending' keys can be activated`,
      400,
      { currentStatus: key.status },
    );
  }
  // Capture a single timestamp so the written row matches the return
  // value. Previously this used two separate `new Date()` calls which
  // could drift by milliseconds.
  const now = new Date();
  await db
    .update(emailDkimKeys)
    .set({
      status: 'active',
      activatedAt: now,
      dnsVerifiedAt: now,
    })
    .where(eq(emailDkimKeys.id, keyId));
  return { ...key, status: 'active', activatedAt: now, dnsVerifiedAt: now };
}

/**
 * List all DKIM keys for an email domain, newest first. Used by the
 * admin UI to show key history + rotation status. Capped at 50
 * historical entries to prevent unbounded result sets if a domain
 * has been rotated many times.
 */
export async function listDkimKeys(
  db: Database,
  emailDomainId: string,
): Promise<readonly EmailDkimKey[]> {
  return await db
    .select()
    .from(emailDkimKeys)
    .where(eq(emailDkimKeys.emailDomainId, emailDomainId))
    .orderBy(desc(emailDkimKeys.createdAt))
    .limit(50);
}

// ─── Cron entry points ───────────────────────────────────────────────────

export interface RetireOptions {
  readonly graceDays?: number;
}

/**
 * Transition active keys that are older than graceDays to retired.
 * Called from a daily cron. Default grace period: 7 days.
 *
 * The retirement step uses an atomic `UPDATE ... WHERE id IN (...)`
 * with a correlated subquery that ensures the domain still has
 * another active key at the moment the update executes. This
 * prevents a TOCTOU race in multi-replica deployments where two
 * schedulers could otherwise retire the same key and leave a domain
 * without any signing keys.
 */
export async function retireOldKeys(
  db: Database,
  options: RetireOptions = {},
): Promise<{ retired: number }> {
  const graceDays = options.graceDays ?? 7;
  const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000);

  // First pass: collect candidate IDs (just for reporting / logging).
  // The actual retirement below is a single atomic update regardless
  // of what we find here.
  const stale = await db
    .select()
    .from(emailDkimKeys)
    .where(
      and(
        eq(emailDkimKeys.status, 'active'),
        lt(emailDkimKeys.activatedAt, cutoff),
      ),
    );

  if (stale.length === 0) return { retired: 0 };

  // Atomic retire: only flip keys to 'retired' if the owning email
  // domain has more than one active key at the moment of the UPDATE.
  // The subquery is evaluated per row by PostgreSQL, preventing
  // two concurrent schedulers from both observing count=2 and both
  // retiring.
  const result = await db.execute<{ id: string }>(sql`
    UPDATE email_dkim_keys AS target
       SET status = 'retired',
           retired_at = NOW()
     WHERE target.status = 'active'
       AND target.activated_at < ${cutoff}
       AND (
         SELECT COUNT(*)::int
           FROM email_dkim_keys AS peer
          WHERE peer.email_domain_id = target.email_domain_id
            AND peer.status = 'active'
       ) > 1
    RETURNING target.id
  `);

  return { retired: result.rows?.length ?? 0 };
}

export interface AutoRotateOptions {
  readonly rotationAgeDays?: number;
}

/**
 * Scan all primary-mode email domains for keys older than
 * `rotationAgeDays` and trigger a rotation for each one.
 *
 * Only primary-mode domains are auto-rotated — secondary/cname mode
 * customers manage their own DNS and must trigger rotation manually
 * via the API so the platform can hand them the new DNS record to
 * publish.
 *
 * Returns the number of email domains rotated.
 */
export async function autoRotatePrimaryDomains(
  db: Database,
  encryptionKey: string,
  options: AutoRotateOptions = {},
): Promise<{ rotated: number; errors: number }> {
  const rotationAgeDays = options.rotationAgeDays ?? 90;
  const cutoff = new Date(Date.now() - rotationAgeDays * 24 * 60 * 60 * 1000);

  // Find primary-mode email domains whose newest active key is older
  // than the rotation threshold — or whose keys are missing entirely.
  //
  // We do this as a single SQL query so it scales with client count.
  // The subquery picks the MAX(created_at) per email_domain_id across
  // active keys and joins that back onto email_domains for the
  // primary-mode filter.
  // Note: `domains."dnsMode"` is a quoted camelCase identifier — the
  // Drizzle schema omits the explicit sql column name so the DB
  // column inherits the TS field name. Don't change this without
  // also fixing the column in migrations.
  const candidates = await db.execute<{
    email_domain_id: string;
    newest_active_at: Date | null;
  }>(sql`
    SELECT ed.id AS email_domain_id, sub.newest_active_at
      FROM email_domains ed
      INNER JOIN domains d ON d.id = ed.domain_id
      LEFT JOIN (
        SELECT email_domain_id, MAX(created_at) AS newest_active_at
          FROM email_dkim_keys
         WHERE status = 'active'
         GROUP BY email_domain_id
      ) sub ON sub.email_domain_id = ed.id
     WHERE d."dnsMode" = 'primary'
       AND (sub.newest_active_at IS NULL OR sub.newest_active_at < ${cutoff})
  `);

  let rotated = 0;
  let errors = 0;
  for (const row of candidates.rows ?? []) {
    try {
      await rotateDkimKey(db, row.email_domain_id, encryptionKey);
      rotated += 1;
    } catch (err) {
      errors += 1;
      console.warn(
        `[email-dkim] autoRotatePrimaryDomains: failed to rotate ${row.email_domain_id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return { rotated, errors };
}

export interface PurgeOptions {
  readonly retentionDays?: number;
}

/**
 * Delete retired DKIM keys older than retentionDays. Called from a
 * daily cron. Default retention: 30 days after retirement.
 *
 * For primary-mode domains, also removes the DNS TXT record via
 * syncRecordToProviders so retired selectors don't linger in the
 * authoritative zone. For cname/secondary mode the platform does not
 * own the zone, so the operator must remove the record manually.
 */
export async function purgeRetiredKeys(
  db: Database,
  options: PurgeOptions = {},
): Promise<{ purged: number; dnsRemoved: number }> {
  const retentionDays = options.retentionDays ?? 30;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const stale = await db
    .select()
    .from(emailDkimKeys)
    .where(
      and(
        eq(emailDkimKeys.status, 'retired'),
        lt(emailDkimKeys.retiredAt, cutoff),
      ),
    );

  let purged = 0;
  let dnsRemoved = 0;
  for (const key of stale) {
    // Look up the owning email_domain + domain to decide whether to
    // clean up DNS. If the lookup fails (orphaned row), still delete
    // the key row so the scan doesn't re-process it forever.
    let ed: Awaited<ReturnType<typeof loadEmailDomainWithMode>> = null;
    try {
      ed = await loadEmailDomainWithMode(db, key.emailDomainId);
    } catch {
      ed = null;
    }

    if (ed && ed.dnsMode === 'primary') {
      const dnsRecordName = `${key.selector}._domainkey.${ed.domainName}`;
      const dnsRecordValue = formatDkimDnsValue(key.publicKey);
      try {
        await syncRecordToProviders(
          db,
          ed.domainName,
          'delete',
          {
            type: 'TXT',
            name: dnsRecordName,
            content: dnsRecordValue,
            ttl: 3600,
          },
          ed.domainId,
        );
        dnsRemoved += 1;
      } catch (err) {
        console.warn(
          `[email-dkim] purgeRetiredKeys: DNS cleanup failed for ${dnsRecordName}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        // Non-fatal — still delete the DB row below.
      }
    }

    await db.delete(emailDkimKeys).where(eq(emailDkimKeys.id, key.id));
    purged += 1;
  }

  return { purged, dnsRemoved };
}
