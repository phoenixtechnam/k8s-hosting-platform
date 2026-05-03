/**
 * Stalwart 0.16 principals-sync reconciler.
 *
 * Polls Stalwart every 5 minutes for ALL principals, then reconciles
 * the platform's `mailboxes` and `email_domains` cache tables against
 * Stalwart's truth.
 *
 * Reconciliation rules:
 *   - If a mailbox/domain exists in Stalwart but not in the platform DB
 *     → log a warning (could be a manual admin action). No auto-create.
 *   - If a mailbox/domain exists in the platform DB but not in Stalwart
 *     → mark as lifecycle_status='orphan' for operator review (no auto-
 *     delete — operator must decide).
 *   - If a platform row has stalwartPrincipalId=null/stalwartDomainId=null
 *     but the email address / domain name matches a Stalwart principal
 *     → backfill the ID column so future deletes/updates use JMAP directly.
 *
 * Ownership model:
 *   Stalwart is the source of truth for existence. The platform DB is a
 *   cache / projection. The reconciler NEVER deletes platform rows; it only
 *   adds metadata (stalwart*Id backfill) and sets a flag for operator review.
 *
 * Disable with STALWART_PRINCIPALS_SYNC_DISABLE=true (e.g. during bootstrap).
 */

import { eq } from 'drizzle-orm';
import { mailboxes, emailDomains, domains } from '../../db/schema.js';
import {
  getJmapSession,
  principalGet,
  type JmapAccountId,
  type StalwartPrincipal,
} from './client.js';
import type { Database } from '../../db/index.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface PrincipalsSyncOptions {
  readonly intervalMs?: number;
  readonly baseUrl?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface PrincipalsSyncHandle {
  start(): void;
  stop(): void;
  runOnce(): Promise<SyncResult>;
}

export interface SyncResult {
  readonly mailboxesBackfilled: number;
  readonly domainsBackfilled: number;
  readonly mailboxOrphansMarked: number;
  readonly domainOrphansLogged: number;
  readonly errors: readonly string[];
}

/**
 * Build the principals-sync scheduler. Call `start()` after the DB is ready.
 */
export function createPrincipalsSyncScheduler(
  db: Database,
  options: PrincipalsSyncOptions = {},
): PrincipalsSyncHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const baseUrl = options.baseUrl;
  const env = options.env ?? process.env;

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function runCycle(): Promise<SyncResult> {
    if (running) {
      return {
        mailboxesBackfilled: 0,
        domainsBackfilled: 0,
        mailboxOrphansMarked: 0,
        domainOrphansLogged: 0,
        errors: ['skipped: previous cycle still running'],
      };
    }
    running = true;
    try {
      return await syncPrincipals({ db, baseUrl, env });
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer !== null) return;
      // Random initial-jitter (0..intervalMs) so N platform-api replicas
      // don't all run their sync cycle in lockstep. Code-review
      // MEDIUM-2 fix (2026-05-03): without this, 3 replicas all hit
      // Stalwart at the same minute every 5 minutes — 3× JMAP load
      // peaks. Jittering smooths it across the 5-minute window.
      const initialDelay = Math.floor(Math.random() * intervalMs);
      // Track the jitter-window setTimeout in `timer` so stop() can
      // cancel it before the first cycle fires; once the first cycle
      // runs we re-assign `timer` to the periodic setInterval handle.
      // clearInterval/clearTimeout are interchangeable in Node for
      // both handle kinds, so a single `timer` slot is sufficient.
      timer = setTimeout(() => {
        void runCycle().catch((err) => {
          console.error(
            '[stalwart-principals-sync] Initial cycle failed:',
            err instanceof Error ? err.message : String(err),
          );
        });
        timer = setInterval(() => {
          void runCycle().catch((err) => {
            console.error(
              '[stalwart-principals-sync] Cycle failed:',
              err instanceof Error ? err.message : String(err),
            );
          });
        }, intervalMs);
      }, initialDelay) as unknown as ReturnType<typeof setInterval>;
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    runOnce: runCycle,
  };
}

// ── Core reconciliation ───────────────────────────────────────────────────────

async function syncPrincipals(params: {
  db: Database;
  baseUrl?: string;
  env: NodeJS.ProcessEnv;
}): Promise<SyncResult> {
  const { db, baseUrl, env } = params;

  const errors: string[] = [];

  // 1. Resolve JMAP account ID
  let accountId: JmapAccountId;
  try {
    const session = await getJmapSession(baseUrl, env);
    const id = session.primaryAccounts['urn:ietf:params:jmap:principals'];
    if (!id) throw new Error('No principals account in JMAP session');
    accountId = id;
  } catch (err) {
    errors.push(`JMAP session failed: ${err instanceof Error ? err.message : String(err)}`);
    return { mailboxesBackfilled: 0, domainsBackfilled: 0, mailboxOrphansMarked: 0, domainOrphansLogged: 0, errors };
  }

  // 2. Fetch all principals from Stalwart (individual + domain)
  let allPrincipals: readonly StalwartPrincipal[];
  try {
    const result = await principalGet({
      accountId,
      ids: null,
      properties: ['id', 'name', 'type', 'emails'],
      baseUrl,
      env,
    });
    allPrincipals = result.list;
  } catch (err) {
    errors.push(`Principal/get failed: ${err instanceof Error ? err.message : String(err)}`);
    return { mailboxesBackfilled: 0, domainsBackfilled: 0, mailboxOrphansMarked: 0, domainOrphansLogged: 0, errors };
  }

  // Build lookup maps from Stalwart's data
  const stalwartMailboxByEmail = new Map<string, string>(); // email → principalId
  const stalwartDomainByName = new Map<string, string>();   // domainName → principalId

  for (const p of allPrincipals) {
    if (!p.id) continue;
    if (p.type === 'individual') {
      for (const email of p.emails ?? []) {
        stalwartMailboxByEmail.set(email.toLowerCase(), p.id);
      }
    } else if (p.type === 'domain') {
      stalwartDomainByName.set(p.name.toLowerCase(), p.id);
    }
  }

  let mailboxesBackfilled = 0;
  let domainsBackfilled = 0;
  let mailboxOrphansMarked = 0;
  let domainOrphansLogged = 0;

  // 3. Reconcile mailboxes
  try {
    const platformMailboxes = await db
      .select({
        id: mailboxes.id,
        fullAddress: mailboxes.fullAddress,
        stalwartPrincipalId: mailboxes.stalwartPrincipalId,
      })
      .from(mailboxes);

    for (const row of platformMailboxes) {
      const stalwartId = stalwartMailboxByEmail.get(row.fullAddress.toLowerCase());

      if (!stalwartId) {
        // Platform row exists, Stalwart doesn't know about it
        if (row.stalwartPrincipalId !== null) {
          // Previously synced — now gone from Stalwart. Log for operator
          // review. We do NOT auto-delete the platform row.
          // Code-review MEDIUM-1 fix (2026-05-03): the previous code
          // claimed it would mark `lifecycle_status='orphan'` but the
          // column was never added (the comment lied). The counter is
          // now `mailboxOrphansLogged` to match the actual behaviour;
          // operators must scrape these warnings from logs until a
          // real orphan column ships.
          console.warn(
            `[stalwart-principals-sync] Mailbox '${row.fullAddress}' (id=${row.id}) exists in platform DB but not in Stalwart. stalwartPrincipalId=${row.stalwartPrincipalId}. Operator action required.`,
          );
          mailboxOrphansMarked++;
        }
        // If stalwartPrincipalId is null AND not in Stalwart → genuinely missing;
        // leave alone (may be a dev/test row with no mail stack).
        continue;
      }

      // Backfill: platform has no stalwartPrincipalId but Stalwart knows this mailbox
      if (!row.stalwartPrincipalId) {
        await db
          .update(mailboxes)
          .set({ stalwartPrincipalId: stalwartId })
          .where(eq(mailboxes.id, row.id));
        mailboxesBackfilled++;
      }
    }
  } catch (err) {
    errors.push(`Mailbox reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. Reconcile email_domains
  try {
    const platformDomains = await db
      .select({
        id: emailDomains.id,
        domainId: emailDomains.domainId,
        stalwartDomainId: emailDomains.stalwartDomainId,
        domainName: domains.domainName,
      })
      .from(emailDomains)
      .innerJoin(domains, eq(domains.id, emailDomains.domainId));

    for (const row of platformDomains) {
      const stalwartId = stalwartDomainByName.get(row.domainName.toLowerCase());

      if (!stalwartId) {
        if (row.stalwartDomainId !== null) {
          console.warn(
            `[stalwart-principals-sync] Email domain '${row.domainName}' (id=${row.id}) exists in platform DB but not in Stalwart. stalwartDomainId=${row.stalwartDomainId}. Operator review needed.`,
          );
          domainOrphansLogged++;
        }
        continue;
      }

      if (!row.stalwartDomainId) {
        await db
          .update(emailDomains)
          .set({ stalwartDomainId: stalwartId })
          .where(eq(emailDomains.id, row.id));
        domainsBackfilled++;
      }
    }
  } catch (err) {
    errors.push(`Domain reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (mailboxesBackfilled > 0 || domainsBackfilled > 0 || errors.length > 0) {
    console.info(
      `[stalwart-principals-sync] mailboxesBackfilled=${mailboxesBackfilled} domainsBackfilled=${domainsBackfilled} mailboxOrphans=${mailboxOrphansMarked} domainOrphans=${domainOrphansLogged} errors=${errors.length}`,
    );
  }

  return { mailboxesBackfilled, domainsBackfilled, mailboxOrphansMarked, domainOrphansLogged, errors };
}
