/**
 * WAF log scraper — lightweight scheduler that reads ModSecurity
 * events from the WAF stack and inserts them into the waf_logs table.
 *
 * Runs every 30 seconds. Reads `kubectl logs --since=35s` to get
 * recent entries with 5s overlap for safety. Deduplicates via
 * ModSecurity's unique_id field.
 *
 * No sidecar, no extra pods, no file mounts — just K8s API calls
 * from the existing backend process.
 *
 * Source pods (Traefik migration, 2026-05-15): the legacy nginx-ingress
 * embedded ModSecurity in the controller itself and emitted "ModSecurity"-
 * prefixed lines. Post-migration the WAF stack is two separate pods in
 * the `traefik` namespace:
 *   - `traefik` DS (entrypoint, modsecurity plugin proxies request bodies)
 *   - `modsec-crs` Deployment (OWASP CRS rule engine, emits the actual
 *     ModSec audit log lines that this scraper parses).
 * We point the scraper at `modsec-crs` because the audit log lives there.
 * If modsec-crs isn't running (single-node clusters where the anti-
 * affinity replicas=2 doesn't satisfy) the scraper returns the SKIP
 * sentinel and emits one info-level log per cycle instead of spamming
 * "No ingress controller pod found" 60x/minute.
 */

import { eq, and, inArray, desc, notInArray, sql, isNull } from 'drizzle-orm';
import crypto from 'crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { wafLogs, ingressRoutes, domains } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseDb = NodePgDatabase<any>;

const SCRAPE_INTERVAL_MS = 30_000;
const LOG_SINCE_SECONDS = 35;
const MAX_LOGS_PER_ROUTE = 50;
// Admin/api/client/platform hosts have route_id=NULL. Cap them as one global
// bucket so a single noisy admin endpoint can't flood the table.
const MAX_LOGS_FOR_ADMIN_HOSTS = 500;
// Field caps mirror the api-contracts Zod schema — bound DB row size against
// attacker-controlled requestUri / message stuffing.
const MAX_REQUEST_URI_LEN = 2048;
const MAX_MESSAGE_LEN = 500;
const INGRESS_NAMESPACE = 'traefik';
// The modsec-crs Deployment in k8s/base/modsecurity-crs/deployment.yaml uses
// `app.kubernetes.io/name=modsec-crs`. The short `app=modsec-crs` label was
// never set, so this selector was silently matching zero pods on every cycle
// since the 2026-05-15 Traefik migration. The bug only became visible after
// the WAF Events tab surfaced an empty scraperStatus banner on 2026-05-19.
const INGRESS_LABEL = 'app.kubernetes.io/name=modsec-crs';

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n);
}

// ─── Scraper health snapshot ─────────────────────────────────────────────
//
// Process-local state updated every cycle so the WAF Events tab can
// distinguish "modsec not deployed" from "scraper running but quiet" from
// "scraper never started". Read via getScraperStatus(); written only by
// runCycle()/scrapeWafLogs().

// Shape must match wafScraperStatusSchema in api-contracts (mutable
// arrays so the Zod-inferred type assigns cleanly).
export interface WafScraperStatus {
  hasRunOnce: boolean;
  lastRunAt: string | null;
  modsecPodFound: boolean;
  lastCycleScraped: number;
  lastCycleInserted: number;
  /** Up to 5 most-recent errors from the last cycle, each ≤256 chars. */
  lastCycleErrors: string[];
  scrapeIntervalMs: number;
}

const status: {
  hasRunOnce: boolean;
  lastRunAt: string | null;
  modsecPodFound: boolean;
  lastCycleScraped: number;
  lastCycleInserted: number;
  lastCycleErrors: string[];
} = {
  hasRunOnce: false,
  lastRunAt: null,
  modsecPodFound: false,
  lastCycleScraped: 0,
  lastCycleInserted: 0,
  lastCycleErrors: [],
};

export function getScraperStatus(): WafScraperStatus {
  return {
    hasRunOnce: status.hasRunOnce,
    lastRunAt: status.lastRunAt,
    modsecPodFound: status.modsecPodFound,
    lastCycleScraped: status.lastCycleScraped,
    lastCycleInserted: status.lastCycleInserted,
    lastCycleErrors: [...status.lastCycleErrors],
    scrapeIntervalMs: SCRAPE_INTERVAL_MS,
  };
}

interface ParsedWafEvent {
  readonly uniqueId: string;
  readonly ruleId: string;
  readonly severity: string;
  readonly message: string;
  readonly requestUri: string;
  readonly requestMethod: string;
  readonly sourceIp: string;
  readonly hostname: string;
}

/**
 * Parse a single ModSecurity log line into a structured event.
 * Returns null if the line isn't a ModSecurity rule match.
 */
function parseModSecurityLine(line: string): ParsedWafEvent | null {
  // Skip non-ModSecurity lines
  if (!line.includes('ModSecurity')) return null;

  const ruleMatch = line.match(/\[id "(\d+)"\]/);
  if (!ruleMatch) return null;

  const ruleId = ruleMatch[1];
  // Skip meta-rules that just report the final score
  if (ruleId === '980170' || ruleId === '980130') return null;

  const msgMatch = line.match(/\[msg "([^"]+)"\]/);
  const uidMatch = line.match(/\[unique_id "([^"]+)"\]/);
  const uriMatch = line.match(/request: "(\w+) ([^ ]+)/);
  const tenantMatch = line.match(/tenant: ([^,]+)/);
  // Error lines have "server: hostname", Warning lines have "[hostname ...]"
  const hostMatch = line.match(/server: ([^,]+)/) || line.match(/\[hostname "([^"]+)"\]/);
  const sevMatch = line.match(/\[severity "(\d+)"\]/);

  const sevNum = sevMatch ? parseInt(sevMatch[1], 10) : 5;
  const severity = sevNum <= 2 ? 'critical' : sevNum <= 4 ? 'warning' : 'info';

  let message = msgMatch ? msgMatch[1] : 'WAF event';
  // Shorten anomaly score messages
  const scoreMatch = message.match(/Total Score: (\d+)/);
  if (scoreMatch) message = `Score: ${scoreMatch[1]}`;

  return {
    uniqueId: uidMatch ? `${uidMatch[1]}:${ruleId}` : `${Date.now()}:${ruleId}`,
    ruleId,
    severity,
    message,
    requestUri: uriMatch ? uriMatch[2] : '/',
    requestMethod: uriMatch ? uriMatch[1] : 'GET',
    sourceIp: tenantMatch ? tenantMatch[1] : '0.0.0.0',
    hostname: hostMatch ? hostMatch[1] : '',
  };
}

/**
 * Scrape ModSecurity logs from the NGINX Ingress Controller
 * and insert new events into the waf_logs table.
 */
export async function scrapeWafLogs(
  db: Database | LooseDb,
  k8s: K8sClients,
): Promise<{ scraped: number; inserted: number; errors: string[] }> {
  const errors: string[] = [];
  let scraped = 0;
  let inserted = 0;

  // 1. Read recent controller logs
  let logOutput: string;
  try {
    const pods = await (k8s.core as unknown as {
      listNamespacedPod: (args: { namespace: string; labelSelector: string }) => Promise<{
        items: { metadata?: { name?: string } }[];
      }>;
    }).listNamespacedPod({
      namespace: INGRESS_NAMESPACE,
      labelSelector: INGRESS_LABEL,
    });

    const podName = pods.items?.[0]?.metadata?.name;
    // SKIP path: modsec-crs not running (e.g. single-node cluster where the
    // anti-affinity replicas=2 doesn't satisfy). Don't spam errors — the
    // scheduler caller treats this as a no-op cycle.
    if (!podName) {
      status.modsecPodFound = false;
      return { scraped: 0, inserted: 0, errors: [] };
    }
    status.modsecPodFound = true;

    logOutput = await (k8s.core as unknown as {
      readNamespacedPodLog: (args: {
        name: string;
        namespace: string;
        sinceSeconds?: number;
      }) => Promise<string>;
    }).readNamespacedPodLog({
      name: podName,
      namespace: INGRESS_NAMESPACE,
      sinceSeconds: LOG_SINCE_SECONDS,
    });

    if (typeof logOutput !== 'string') logOutput = '';
  } catch (err) {
    return { scraped: 0, inserted: 0, errors: [`Failed to read controller logs: ${err instanceof Error ? err.message : String(err)}`] };
  }

  // 2. Parse ModSecurity events — two-pass to resolve hostnames
  // Pass 1: Parse all lines and group by unique_id prefix
  const lines = logOutput.split('\n');
  const allParsed: ParsedWafEvent[] = [];
  const uidToHostname = new Map<string, string>();

  for (const line of lines) {
    const event = parseModSecurityLine(line);
    if (!event) continue;
    allParsed.push(event);
    // The blocking rule (949110) includes "server: hostname" and "tenant: ip" in [error] lines
    // Use it to map unique_id → hostname/ip/uri for all related rules
    const uidPrefix = event.uniqueId.split(':')[0];
    const serverMatch = line.match(/server: ([^,]+)/);
    if (serverMatch && serverMatch[1]) {
      uidToHostname.set(uidPrefix, serverMatch[1]);
    }
    // Also store tenant IP and request URI from error lines for the group
    if (event.sourceIp !== '0.0.0.0') uidToHostname.set(`${uidPrefix}:ip`, event.sourceIp);
    if (event.requestUri !== '/') uidToHostname.set(`${uidPrefix}:uri`, event.requestUri);
    if (event.requestMethod !== 'GET') uidToHostname.set(`${uidPrefix}:method`, event.requestMethod);
  }

  // Pass 2: Assign resolved hostnames and deduplicate
  const events: ParsedWafEvent[] = [];
  const seenUids = new Set<string>();
  for (const event of allParsed) {
    if (seenUids.has(event.uniqueId)) continue;
    seenUids.add(event.uniqueId);
    const uidPrefix = event.uniqueId.split(':')[0];
    const resolvedHostname = uidToHostname.get(uidPrefix) || event.hostname;
    if (!resolvedHostname || resolvedHostname === '127.0.0.1') continue;
    const resolvedIp = event.sourceIp !== '0.0.0.0' ? event.sourceIp : (uidToHostname.get(`${uidPrefix}:ip`) || '0.0.0.0');
    const resolvedUri = event.requestUri !== '/' ? event.requestUri : (uidToHostname.get(`${uidPrefix}:uri`) || '/');
    const resolvedMethod = event.requestMethod !== 'GET' ? event.requestMethod : (uidToHostname.get(`${uidPrefix}:method`) || 'GET');
    events.push({ ...event, hostname: resolvedHostname, sourceIp: resolvedIp, requestUri: resolvedUri, requestMethod: resolvedMethod });
    scraped++;
  }

  if (events.length === 0) return { scraped: 0, inserted: 0, errors: [] };

  // 3. Resolve hostnames to route IDs
  const hostnames = [...new Set(events.map(e => e.hostname))];
  const routes = await db
    .select({
      id: ingressRoutes.id,
      hostname: ingressRoutes.hostname,
      domainId: ingressRoutes.domainId,
    })
    .from(ingressRoutes)
    .where(inArray(ingressRoutes.hostname, hostnames));

  const routeMap = new Map<string, { id: string; domainId: string }>();
  for (const r of routes) routeMap.set(r.hostname, { id: r.id, domainId: r.domainId });

  // Resolve domain → tenant mapping
  const domainIds = [...new Set(routes.map(r => r.domainId))];
  const domainRows = domainIds.length > 0
    ? await db.select({ id: domains.id, tenantId: domains.tenantId }).from(domains).where(inArray(domains.id, domainIds))
    : [];
  const tenantMap = new Map<string, string>();
  for (const d of domainRows) tenantMap.set(d.id, d.tenantId);

  // 4. Insert events (skip duplicates via unique_id hash). Events whose
  // hostname doesn't match an ingress_routes row get inserted with
  // route_id=NULL + tenant_id=NULL — admin/api/client/platform hosts that
  // are not per-tenant routes. They're visible in the cluster-wide WAF
  // events viewer (/admin/security/waf-events, super_admin only).
  let adminHostsTouched = false;
  for (const event of events) {
    const route = routeMap.get(event.hostname);
    const tenantId = route ? tenantMap.get(route.domainId) ?? null : null;
    if (!route) adminHostsTouched = true;

    try {
      await db.insert(wafLogs).values({
        id: crypto.randomUUID(),
        routeId: route?.id ?? null,
        tenantId,
        hostname: truncate(event.hostname, 255),
        ruleId: event.ruleId,
        severity: event.severity,
        message: truncate(event.message, MAX_MESSAGE_LEN),
        requestUri: truncate(event.requestUri, MAX_REQUEST_URI_LEN),
        requestMethod: event.requestMethod,
        sourceIp: event.sourceIp,
      });
      inserted++;
    } catch (err: unknown) {
      // Duplicate or constraint error — skip
      const pgErr = err as { code?: string };
      if (pgErr.code !== '23505') {
        errors.push(`Insert failed for rule ${event.ruleId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // 5a. Prune old logs (keep last MAX_LOGS_PER_ROUTE per route).
  for (const route of routes) {
    try {
      const [{ count: logCount }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(wafLogs)
        .where(eq(wafLogs.routeId, route.id));

      if (Number(logCount ?? 0) > MAX_LOGS_PER_ROUTE) {
        const keepRows = await db
          .select({ id: wafLogs.id })
          .from(wafLogs)
          .where(eq(wafLogs.routeId, route.id))
          .orderBy(desc(wafLogs.createdAt))
          .limit(MAX_LOGS_PER_ROUTE);

        const keepIds = keepRows.map(r => r.id);
        if (keepIds.length > 0) {
          await db.delete(wafLogs).where(
            and(eq(wafLogs.routeId, route.id), notInArray(wafLogs.id, keepIds)),
          );
        }
      }
    } catch {
      // Non-fatal — pruning failure shouldn't break the scraper
    }
  }

  // 5b. Prune admin-host bucket (route_id IS NULL) — capped globally.
  if (adminHostsTouched) {
    try {
      const [{ count: adminCount }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(wafLogs)
        .where(isNull(wafLogs.routeId));

      if (Number(adminCount ?? 0) > MAX_LOGS_FOR_ADMIN_HOSTS) {
        const keepRows = await db
          .select({ id: wafLogs.id })
          .from(wafLogs)
          .where(isNull(wafLogs.routeId))
          .orderBy(desc(wafLogs.createdAt))
          .limit(MAX_LOGS_FOR_ADMIN_HOSTS);

        const keepIds = keepRows.map(r => r.id);
        if (keepIds.length > 0) {
          await db.delete(wafLogs).where(
            and(isNull(wafLogs.routeId), notInArray(wafLogs.id, keepIds)),
          );
        }
      }
    } catch {
      // Non-fatal
    }
  }

  return { scraped, inserted, errors };
}

/**
 * Start the WAF log scraper scheduler.
 * Returns the interval handle for cleanup on shutdown.
 */
export function startWafLogScraper(
  db: Database,
  k8s: K8sClients,
): NodeJS.Timeout {
  console.log('[waf-log-scraper] Starting WAF log scraper');

  const runCycle = async () => {
    try {
      const result = await scrapeWafLogs(db, k8s);
      status.lastCycleScraped = result.scraped;
      status.lastCycleInserted = result.inserted;
      status.lastCycleErrors = result.errors.slice(-5).map((e) => e.slice(0, 256));
      if (result.inserted > 0) {
        console.log(`[waf-log-scraper] scraped=${result.scraped} inserted=${result.inserted}`);
      }
      if (result.errors.length > 0) {
        console.warn('[waf-log-scraper] errors:', result.errors.join('; '));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      status.lastCycleErrors = [msg.slice(0, 256)];
      console.warn('[waf-log-scraper] cycle error:', msg);
    } finally {
      status.hasRunOnce = true;
      status.lastRunAt = new Date().toISOString();
    }
  };

  setTimeout(runCycle, 15_000); // Initial delay
  return setInterval(runCycle, SCRAPE_INTERVAL_MS);
}
