/**
 * Domain verification notification helpers.
 *
 * Covers two notification types:
 *   dns_regression      — a previously verified domain fails verification.
 *   dns_grace_unverified — a domain has never been verified after 72 h.
 *
 * Both are in-app only for Phase 1.
 * Email dispatch is gated by system_settings.notify_dns_failures_via_email
 * (default false). The email branch has a TODO for wiring in the mail sender.
 */

import { and, eq, gt, isNull, like, lt } from 'drizzle-orm';
import { notifications, users, domains } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { VerificationResult } from './verification.js';

const REGRESSION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function formatRelativeTime(date: Date | null | undefined): string {
  if (!date) return 'never';
  const diffMs = Date.now() - date.getTime();
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return '1 day ago';
  return `${diffDays} days ago`;
}

/**
 * Find the primary user id for the given client.
 * Prefers users with the 'owner' role; falls back to any active client-panel user.
 */
async function findClientOwnerUserId(
  db: Database,
  clientId: string,
): Promise<string | null> {
  // Try to find an 'owner' role user first
  const ownerRows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.clientId, clientId),
        eq(users.panel, 'client'),
        eq(users.status, 'active'),
        eq(users.roleName, 'owner'),
      ),
    )
    .limit(1);
  if (ownerRows.length > 0) return ownerRows[0].id;

  // Fall back to any active client-panel user
  const anyRows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.clientId, clientId),
        eq(users.panel, 'client'),
        eq(users.status, 'active'),
      ),
    )
    .limit(1);
  return anyRows.length > 0 ? (anyRows[0].id ?? null) : null;
}

// ─── Regression Notification ─────────────────────────────────────────────────

export async function notifyDomainRegression(
  db: Database,
  domain: { id: string; clientId: string; domainName: string; verifiedAt: Date | null },
  result: VerificationResult,
): Promise<{ sent: boolean; reason?: string }> {
  // 7-day cooldown: don't spam the client if verification keeps failing.
  // HIGH fix from code review: filter on title prefix so a prior
  // grace-unverified notification doesn't suppress regression alerts —
  // they're independent signals.
  const cooldownCutoff = new Date(Date.now() - REGRESSION_COOLDOWN_MS);
  const existing = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.resourceType, 'domain'),
        eq(notifications.resourceId, domain.id),
        like(notifications.title, 'Domain verification failed:%'),
        gt(notifications.createdAt, cooldownCutoff),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    return { sent: false, reason: 'cooldown' };
  }

  const recipientId = await findClientOwnerUserId(db, domain.clientId);
  if (!recipientId) {
    return { sent: false, reason: 'no_recipient' };
  }

  const failedChecks = result.checks.filter((c) => c.status === 'fail');
  const lastVerifiedStr = formatRelativeTime(domain.verifiedAt);
  const checkDetails = failedChecks.map((c) => `• ${c.detail}`).join('\n');

  const message = [
    `The domain ${domain.domainName} was previously verified (${lastVerifiedStr}) but DNS verification has now failed.`,
    '',
    'Failed checks:',
    checkDetails,
    '',
    'Please check your DNS settings and click "Verify DNS" in the control panel once you have updated them.',
  ].join('\n');

  await db.insert(notifications).values({
    id: crypto.randomUUID(),
    userId: recipientId,
    type: 'warning',
    title: `Domain verification failed: ${domain.domainName}`,
    message,
    resourceType: 'domain',
    resourceId: domain.id,
  });

  // TODO: email dispatch (gated by system_settings.notify_dns_failures_via_email)
  // When true AND client has contact email, send via the existing mail-submit path.

  return { sent: true };
}

// ─── 72h Grace Unverified Notification ───────────────────────────────────────

export async function notifyDomainGraceUnverified(
  db: Database,
  domain: { id: string; clientId: string; domainName: string; createdAt: Date },
): Promise<{ sent: boolean; reason?: string }> {
  // Dedup: only notify once per domain. HIGH fix — filter on title so a
  // regression notification doesn't permanently suppress the grace alert
  // for a domain that briefly verified, regressed, and is otherwise
  // never-verified-stable.
  const existing = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.resourceType, 'domain'),
        eq(notifications.resourceId, domain.id),
        like(notifications.title, 'Domain not yet verified:%'),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    return { sent: false, reason: 'already_notified' };
  }

  const recipientId = await findClientOwnerUserId(db, domain.clientId);
  if (!recipientId) {
    return { sent: false, reason: 'no_recipient' };
  }

  const message = [
    `The domain ${domain.domainName} was added ${formatRelativeTime(domain.createdAt)} but has not yet passed DNS verification.`,
    '',
    'To complete setup, make sure your DNS records point to the platform\'s ingress IP (check the Routing tab in your domain settings for the required address).',
    '',
    'Once updated, click "Verify DNS" in the control panel. DNS changes can take up to 24 hours to propagate.',
  ].join('\n');

  await db.insert(notifications).values({
    id: crypto.randomUUID(),
    userId: recipientId,
    type: 'warning',
    title: `Domain not yet verified: ${domain.domainName}`,
    message,
    resourceType: 'domain',
    resourceId: domain.id,
  });

  // TODO: email dispatch (gated by system_settings.notify_dns_failures_via_email)

  return { sent: true };
}
