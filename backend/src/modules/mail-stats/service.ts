/**
 * Lightweight mail metrics via Stalwart's admin REST API.
 *
 * Phase 3.D.1 — The user's constraint was "keep the platform
 * lightweight, no Prometheus". Instead of installing Prometheus +
 * ServiceMonitor + Grafana, we just proxy Stalwart's own admin API
 * through the backend to the admin panel.
 *
 * Stalwart exposes:
 *   - GET /metrics (Prometheus text format) — cumulative counters
 *   - GET /metrics/prometheus (same)
 *   - GET /api/* — JSON admin endpoints for queue state, principals, etc.
 *
 * For now we just parse the Prometheus text format and return the
 * counters as JSON. The admin panel can render simple cards showing
 * current values. Historical trends are a follow-up (requires a
 * polling cron + mail_metrics table, scheduled for a later phase).
 */

import type { Database } from '../../db/index.js';
import { mailboxes } from '../../db/schema.js';
import { eq, sql } from 'drizzle-orm';

const STALWART_MGMT_URL =
  process.env.STALWART_MGMT_URL ?? 'http://stalwart-mail-mgmt.mail.svc.cluster.local:8080';

export interface MailStatsResponse {
  readonly stalwartReachable: boolean;
  readonly counters: Record<string, number>;
  readonly mailboxSummary: {
    readonly total: number;
    readonly active: number;
    readonly suspended: number;
    readonly totalQuotaMb: number;
    readonly totalUsedMb: number;
  };
  readonly fetchedAt: string;
}

/**
 * Parse a Prometheus-format metrics text block into a flat map.
 * Lines like `stalwart_messages_received_total 42` become
 * `{ "stalwart_messages_received_total": 42 }`. Labelled metrics
 * (with {...}) are collapsed by their base name plus a short label
 * suffix.
 */
function parsePrometheusText(text: string): Record<string, number> {
  const result: Record<string, number> = {};
  const lines = text.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // name{labels} value OR name value
    const match = /^([a-zA-Z_][a-zA-Z0-9_]*)(\{[^}]*\})?\s+([+-]?[\d.eE]+)/.exec(line);
    if (!match) continue;
    const [, name, labels, value] = match;
    const num = parseFloat(value);
    if (!Number.isFinite(num)) continue;
    // If labeled, flatten to `name{labels}` key; callers can summarize.
    const key = labels ? `${name}${labels}` : name;
    result[key] = num;
  }
  return result;
}

/**
 * Fetch current mail server stats.
 *
 * Reads:
 *   - Stalwart /metrics endpoint (counters)
 *   - platform DB for the mailbox summary
 *
 * Non-blocking on Stalwart unreachability — returns
 * `stalwartReachable: false` and the DB summary alone, so the admin
 * panel can still render something useful.
 */
export async function getMailStats(db: Database): Promise<MailStatsResponse> {
  // Fetch Stalwart metrics
  let counters: Record<string, number> = {};
  let stalwartReachable = false;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${STALWART_MGMT_URL}/metrics`, {
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (res.ok) {
      const text = await res.text();
      counters = parsePrometheusText(text);
      stalwartReachable = true;
    }
  } catch {
    // Non-fatal — just return the DB summary.
    stalwartReachable = false;
  }

  // Mailbox summary from the platform DB — cheap, always works
  const [summaryRow] = await db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where status = 'active')::int`,
      suspended: sql<number>`count(*) filter (where status = 'suspended')::int`,
      totalQuotaMb: sql<number>`coalesce(sum(${mailboxes.quotaMb}), 0)::int`,
      totalUsedMb: sql<number>`coalesce(sum(${mailboxes.usedMb}), 0)::int`,
    })
    .from(mailboxes);

  return {
    stalwartReachable,
    counters,
    mailboxSummary: {
      total: summaryRow?.total ?? 0,
      active: summaryRow?.active ?? 0,
      suspended: summaryRow?.suspended ?? 0,
      totalQuotaMb: summaryRow?.totalQuotaMb ?? 0,
      totalUsedMb: summaryRow?.totalUsedMb ?? 0,
    },
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Periodic reconciler: query Stalwart for each mailbox's actual disk
 * usage and update mailboxes.used_mb in the platform DB.
 *
 * Phase 3.D.2 — runs every 15 minutes by default (configurable via
 * platform_settings key `mailbox_usage_sync_interval_minutes`). This
 * replaces the "always 0" default that Phase 2a shipped.
 *
 * The Stalwart principal API returns used-quota-bytes. We divide by
 * 1024*1024 and write back.
 *
 * Non-blocking — individual mailbox errors are logged and skipped so
 * a single bad row doesn't kill the whole sync.
 */
export async function reconcileMailboxUsage(
  db: Database,
  logger: { info: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void } = {
    info: () => {},
    warn: () => {},
  },
): Promise<{ synced: number; failed: number }> {
  const adminSecret = process.env.STALWART_ADMIN_SECRET ?? '';
  const auth = adminSecret
    ? `Basic ${Buffer.from(`admin:${adminSecret}`).toString('base64')}`
    : '';

  // List active mailboxes that need a usage update
  const rows = await db
    .select({ id: mailboxes.id, fullAddress: mailboxes.fullAddress })
    .from(mailboxes)
    .where(eq(mailboxes.status, 'active'));

  let synced = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(
        `${STALWART_MGMT_URL}/api/principal/${encodeURIComponent(row.fullAddress)}`,
        {
          signal: controller.signal,
          headers: auth ? { Authorization: auth } : {},
        },
      ).finally(() => clearTimeout(timeout));

      if (!res.ok) {
        failed += 1;
        continue;
      }
      const data = (await res.json()) as { usedQuota?: number };
      const usedBytes = Number(data.usedQuota ?? 0);
      if (!Number.isFinite(usedBytes)) {
        failed += 1;
        continue;
      }
      const usedMb = Math.round(usedBytes / (1024 * 1024));
      await db
        .update(mailboxes)
        .set({ usedMb })
        .where(eq(mailboxes.id, row.id));
      synced += 1;
    } catch {
      failed += 1;
    }
  }

  logger.info(
    { synced, failed },
    'reconcileMailboxUsage: Stalwart mailbox usage sync complete',
  );

  return { synced, failed };
}

// Exported for unit tests
export const __testing__ = {
  parsePrometheusText,
};
