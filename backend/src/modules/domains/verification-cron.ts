/**
 * Domain Verification Cron — Phase 3.
 *
 * Runs hourly. For each domain whose verification cache is older than 24h
 * (or has never been cached), re-runs DNS verification and updates the DB.
 *
 * On startup, immediately drains any domains with verification_cache_at IS NULL
 * to avoid a 1h wait on freshly bootstrapped clusters.
 *
 * Notification rules:
 *   - regression (verified → unverified): emit dns_regression notification
 *     UNLESS platform IPs changed this tick (false positive suppression).
 *   - 72h-since-creation never-verified: emit dns_grace_unverified once.
 *
 * Multi-replica safety: per-row idempotency; no explicit locking needed.
 * Last-writer-wins on system_settings.last_known_platform_ips is acceptable.
 */

import { and, eq, isNull, lt, not, inArray, or, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../../db/index.js';
import { domains, systemSettings, tenants } from '../../db/schema.js';
import { getPlatformIngressIps, getPlatformConfig, verifyDomain } from './verification.js';
import { setDomainVerificationStatus } from './service.js';
import { notifyDomainRegression, notifyDomainGraceUnverified } from './notifications.js';
import type { PlatformIngressIps } from './verification.js';

const CRON_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CANDIDATES_PER_TICK = 200;
const BETWEEN_DOMAINS_MS = 250;
const GRACE_WINDOW_START_MS = 72 * 60 * 60 * 1000; // 72h
const GRACE_WINDOW_END_MS = 90 * 60 * 60 * 1000;   // 90h

// Prevent concurrent ticks (module-level flag scopes to this replica)
let ticking = false;

// Module-level last-known IPs for change detection
let lastKnownIps: { v4: string[]; v6: string[] } | null = null;

function sortedIpArrays(ips: PlatformIngressIps): { v4: string[]; v6: string[] } {
  return {
    v4: [...ips.v4].sort(),
    v6: [...ips.v6].sort(),
  };
}

function ipsChanged(
  prev: { v4: string[]; v6: string[] },
  curr: { v4: string[]; v6: string[] },
): boolean {
  if (prev.v4.length !== curr.v4.length || prev.v6.length !== curr.v6.length) return true;
  return (
    prev.v4.some((ip, i) => ip !== curr.v4[i]) ||
    prev.v6.some((ip, i) => ip !== curr.v6[i])
  );
}

async function loadLastKnownIps(db: Database): Promise<void> {
  try {
    const rows = await db
      .select({ lastKnownPlatformIps: systemSettings.lastKnownPlatformIps })
      .from(systemSettings)
      .limit(1);
    const stored = rows[0]?.lastKnownPlatformIps;
    if (stored && typeof stored === 'object' && 'v4' in stored && 'v6' in stored) {
      lastKnownIps = stored as { v4: string[]; v6: string[] };
    }
  } catch {
    // Non-fatal — start with no last-known IPs
  }
}

async function persistLastKnownIps(db: Database, ips: { v4: string[]; v6: string[] }): Promise<void> {
  try {
    // last-writer-wins across replicas — acceptable for IP-change detection
    await db.update(systemSettings).set({ lastKnownPlatformIps: ips });
  } catch {
    // Non-fatal
  }
}

async function tick(db: Database, log: FastifyBaseLogger): Promise<void> {
  const since = new Date(Date.now() - CACHE_MAX_AGE_MS);

  // 1. Compute current platform IPs (once per tick)
  let platformConfig;
  try {
    platformConfig = await getPlatformConfig(db);
  } catch (err) {
    log.warn({ err }, '[verify-cron] getPlatformConfig failed — skipping tick');
    return;
  }

  let currentPlatformIps: PlatformIngressIps;
  try {
    currentPlatformIps = await getPlatformIngressIps(db, platformConfig.ingressHostname);
  } catch (err) {
    log.warn({ err }, '[verify-cron] getPlatformIngressIps failed — skipping tick');
    return;
  }

  const currentSorted = sortedIpArrays(currentPlatformIps);

  // 2. Detect platform IP change — suppress regression notifications this tick if changed
  let platformIpsChanged = false;
  if (lastKnownIps !== null) {
    platformIpsChanged = ipsChanged(lastKnownIps, currentSorted);
    if (platformIpsChanged) {
      log.info(
        { prev: lastKnownIps, curr: currentSorted },
        '[verify-cron] platform IPs changed — suppressing regression notifications this tick',
      );
    }
  }

  // Update in-memory + persistent store
  lastKnownIps = currentSorted;
  void persistLastKnownIps(db, currentSorted);

  // 3. Fetch candidates: not suspended/deleted, cache stale or absent
  let candidates: Array<{
    id: string;
    domainName: string;
    dnsMode: 'primary' | 'cname' | 'secondary';
    status: string;
    verifiedAt: Date | null;
    tenantId: string;
    createdAt: Date;
  }>;
  try {
    // SYSTEM-tenant filter (ADR-040): the platform apex domain owned
    // by the SYSTEM tenant is configured by the operator at bootstrap
    // (A records on the parent zone) — it doesn't have its own NS
    // delegation, so verifyNsDelegation falls over with ENODATA every
    // tick and flips the row to `unverified`. The SYSTEM domain isn't
    // a tenant-managed surface; skip it. ensureSystemApexDomain stamps
    // status='verified' on insert as belt-and-braces.
    candidates = await db
      .select({
        id: domains.id,
        domainName: domains.domainName,
        dnsMode: domains.dnsMode,
        status: domains.status,
        verifiedAt: domains.verifiedAt,
        tenantId: domains.tenantId,
        createdAt: domains.createdAt,
      })
      .from(domains)
      .innerJoin(tenants, eq(tenants.id, domains.tenantId))
      .where(
        and(
          not(inArray(domains.status, ['suspended', 'deleted'])),
          eq(tenants.isSystem, false),
          or(
            isNull(domains.verificationCacheAt),
            lt(domains.verificationCacheAt, since),
          ),
        ),
      )
      // HIGH fix from code review: PostgreSQL default puts NULLs LAST.
      // Without NULLS FIRST, freshly created domains (cache_at=null) sort
      // after stale-cached rows and can starve when the 200-row limit is hit.
      .orderBy(sql`${domains.verificationCacheAt} ASC NULLS FIRST`)
      .limit(MAX_CANDIDATES_PER_TICK);
  } catch (err) {
    log.warn({ err }, '[verify-cron] failed to fetch candidates — skipping tick');
    return;
  }

  log.info(`[verify-cron] tick — ${candidates.length} candidate(s) to verify`);

  // 4. Process each candidate
  for (const candidate of candidates) {
    try {
      const result = await verifyDomain(
        candidate.domainName,
        candidate.dnsMode,
        platformConfig,
        db,
        currentPlatformIps,
      );

      const { transition } = await setDomainVerificationStatus(db, candidate.id, result);

      log.debug(
        { domain: candidate.domainName, transition },
        '[verify-cron] verification complete',
      );

      // Emit regression notification if applicable
      if (transition === 'regression' && !platformIpsChanged) {
        try {
          await notifyDomainRegression(db, {
            id: candidate.id,
            tenantId: candidate.tenantId,
            domainName: candidate.domainName,
            verifiedAt: candidate.verifiedAt,
          }, result);
        } catch (notifyErr) {
          log.warn({ err: notifyErr, domain: candidate.domainName }, '[verify-cron] regression notify failed');
        }
      }
    } catch (err) {
      log.warn({ err, domain: candidate.domainName }, '[verify-cron] verification failed for domain');
    }

    // Throttle to avoid hammering DNS resolvers
    await new Promise<void>((r) => setTimeout(r, BETWEEN_DOMAINS_MS));
  }

  // 5. 72h grace notifications (never-verified, 72-90h window)
  const graceStart = new Date(Date.now() - GRACE_WINDOW_START_MS);
  const graceEnd = new Date(Date.now() - GRACE_WINDOW_END_MS);
  try {
    // ADR-040: same SYSTEM-tenant exclusion as the main candidate
    // query — never send "domain unverified" notifications about the
    // platform's own apex.
    const graceTargets = await db
      .select({
        id: domains.id,
        tenantId: domains.tenantId,
        domainName: domains.domainName,
        createdAt: domains.createdAt,
      })
      .from(domains)
      .innerJoin(tenants, eq(tenants.id, domains.tenantId))
      .where(
        and(
          isNull(domains.verifiedAt),
          eq(tenants.isSystem, false),
          lt(domains.createdAt, graceStart),
          not(lt(domains.createdAt, graceEnd)),
        ),
      );

    for (const target of graceTargets) {
      try {
        await notifyDomainGraceUnverified(db, target);
      } catch (err) {
        log.warn({ err, domain: target.domainName }, '[verify-cron] grace notify failed');
      }
    }
  } catch (err) {
    log.warn({ err }, '[verify-cron] grace notification sweep failed');
  }

  log.info(`[verify-cron] tick complete — processed ${candidates.length} domain(s)`);
}

export interface VerificationCronHandle {
  stop: () => void;
}

export async function startVerificationCron(
  db: Database,
  log: FastifyBaseLogger,
): Promise<VerificationCronHandle> {
  // Restore last-known IPs from DB
  await loadLastKnownIps(db);

  // Immediate first tick if there are un-cached unverified domains
  void (async () => {
    try {
      // ADR-040: don't count SYSTEM-owned domains when deciding
      // whether to fire the initial-tick — otherwise every fresh
      // bootstrap would trigger the cron on a domain it can't
      // verify.
      const uncached = await db
        .select({ id: domains.id })
        .from(domains)
        .innerJoin(tenants, eq(tenants.id, domains.tenantId))
        .where(
          and(
            isNull(domains.verificationCacheAt),
            eq(tenants.isSystem, false),
            not(inArray(domains.status, ['suspended', 'deleted'])),
          ),
        )
        .limit(1);

      if (uncached.length > 0) {
        log.info('[verify-cron] firing initial tick — uncached unverified domains found');
        if (!ticking) {
          ticking = true;
          tick(db, log)
            .catch((err) => log.warn({ err }, '[verify-cron] initial tick failed'))
            .finally(() => { ticking = false; });
        }
      }
    } catch (err) {
      log.warn({ err }, '[verify-cron] startup check failed');
    }
  })();

  // Hourly interval
  const timer = setInterval(() => {
    if (ticking) {
      log.debug('[verify-cron] previous tick still running — skipping');
      return;
    }
    ticking = true;
    tick(db, log)
      .catch((err) => log.warn({ err }, '[verify-cron] tick failed'))
      .finally(() => { ticking = false; });
  }, CRON_INTERVAL_MS);

  return { stop: () => clearInterval(timer) };
}

/** Test-only: reset module-level state between test cases. */
export function _resetCronStateForTests(): void {
  ticking = false;
  lastKnownIps = null;
}
