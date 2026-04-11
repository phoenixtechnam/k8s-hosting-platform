/**
 * WAF log scraper — lightweight scheduler that reads ModSecurity
 * events from the NGINX Ingress Controller logs and inserts them
 * into the waf_logs table.
 *
 * Runs every 30 seconds. Reads `kubectl logs --since=35s` to get
 * recent entries with 5s overlap for safety. Deduplicates via
 * ModSecurity's unique_id field.
 *
 * No sidecar, no extra pods, no file mounts — just K8s API calls
 * from the existing backend process.
 */

import { eq, and, inArray, desc, notInArray, sql } from 'drizzle-orm';
import crypto from 'crypto';
import { wafLogs, ingressRoutes, domains } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const SCRAPE_INTERVAL_MS = 30_000;
const LOG_SINCE_SECONDS = 35;
const MAX_LOGS_PER_ROUTE = 50;
const INGRESS_NAMESPACE = 'ingress-nginx';
const INGRESS_LABEL = 'app.kubernetes.io/name=ingress-nginx,app.kubernetes.io/component=controller';

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
  const clientMatch = line.match(/client: ([^,]+)/);
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
    sourceIp: clientMatch ? clientMatch[1] : '0.0.0.0',
    hostname: hostMatch ? hostMatch[1] : '',
  };
}

/**
 * Scrape ModSecurity logs from the NGINX Ingress Controller
 * and insert new events into the waf_logs table.
 */
export async function scrapeWafLogs(
  db: Database,
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
    if (!podName) return { scraped: 0, inserted: 0, errors: ['No ingress controller pod found'] };

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
    // The blocking rule (949110) includes "server: hostname" and "client: ip" in [error] lines
    // Use it to map unique_id → hostname/ip/uri for all related rules
    const uidPrefix = event.uniqueId.split(':')[0];
    const serverMatch = line.match(/server: ([^,]+)/);
    if (serverMatch && serverMatch[1]) {
      uidToHostname.set(uidPrefix, serverMatch[1]);
    }
    // Also store client IP and request URI from error lines for the group
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

  // Resolve domain → client mapping
  const domainIds = [...new Set(routes.map(r => r.domainId))];
  const domainRows = domainIds.length > 0
    ? await db.select({ id: domains.id, clientId: domains.clientId }).from(domains).where(inArray(domains.id, domainIds))
    : [];
  const clientMap = new Map<string, string>();
  for (const d of domainRows) clientMap.set(d.id, d.clientId);

  // 4. Insert events (skip duplicates via unique_id hash)
  for (const event of events) {
    const route = routeMap.get(event.hostname);
    if (!route) continue;
    const clientId = clientMap.get(route.domainId);
    if (!clientId) continue;

    try {
      await db.insert(wafLogs).values({
        id: crypto.randomUUID(),
        routeId: route.id,
        clientId,
        ruleId: event.ruleId,
        severity: event.severity,
        message: event.message,
        requestUri: event.requestUri,
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

  // 5. Prune old logs (keep last MAX_LOGS_PER_ROUTE per route)
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
      if (result.inserted > 0) {
        console.log(`[waf-log-scraper] scraped=${result.scraped} inserted=${result.inserted}`);
      }
      if (result.errors.length > 0) {
        console.warn('[waf-log-scraper] errors:', result.errors.join('; '));
      }
    } catch (err) {
      console.warn('[waf-log-scraper] cycle error:', err instanceof Error ? err.message : String(err));
    }
  };

  setTimeout(runCycle, 15_000); // Initial delay
  return setInterval(runCycle, SCRAPE_INTERVAL_MS);
}
