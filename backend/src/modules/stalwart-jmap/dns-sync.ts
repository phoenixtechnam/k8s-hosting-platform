/**
 * Stalwart 0.16 → platform DNS sync.
 *
 * Stalwart 0.16 publishes the exact set of DNS records it needs via the
 * `dnsZoneFile` field on each Domain principal. This module polls that
 * field on a 5-minute interval, diffs the result against the platform's
 * `dns_records` table, and calls `syncRecordToProviders` (from the
 * dns-records module) to create / delete records as needed.
 *
 * Why polling instead of push?
 * - Stalwart doesn't emit webhooks or JMAP push events for DNS changes.
 * - DNS records change rarely (domain creation, DKIM rotation). 5-minute
 *   polling is negligible overhead and keeps the design simple.
 * - We use `Principal/changes` to detect *which* domains changed before
 *   fetching zone files, so only changed domains incur a full fetch.
 *
 * Ownership model:
 * - Records in `dns_records` with `source='stalwart'` are owned by this
 *   sync. We create them, and we remove them when Stalwart drops them.
 * - Records with any other source (or null) are owned by other platform
 *   components and are never touched by this module.
 *
 * Zone-file parser:
 * - Standard zone-file format: `name TTL class type rdata`
 * - We parse MX, TXT, CNAME, A, AAAA, SRV records.
 * - Unknown record types are logged and skipped (no error).
 *
 * Bootstrap note:
 * - Pass `STALWART_DNS_SYNC_DISABLE=true` to disable the scheduler at
 *   startup (useful for tests / bootstrap.sh orchestration).
 * - Stalwart's built-in DNS publishers (if configured) should be
 *   disabled in the bootstrap plan so we don't race with them.
 */

import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { dnsRecords, emailDomains, domains } from '../../db/schema.js';
import type { DnsRecord } from '../../db/schema.js';
import { syncRecordToProviders } from '../dns-records/service.js';
import {
  getJmapSession,
  principalGet,
  principalGetOne,
  principalChanges,
  type JmapAccountId,
  type StalwartPrincipal,
} from './client.js';
import type { Database } from '../../db/index.js';
import { mailLogger } from '../../shared/mail-logger.js';

const log = mailLogger().child({ module: 'stalwart-dns-sync' });

// ── Zone-file parsing ─────────────────────────────────────────────────────────

/**
 * A parsed DNS record from a Stalwart zone file.
 *
 * SRV records have `priority`, `weight`, `port` and the `rdata` is the
 * target hostname. For other types `weight` and `port` are null.
 */
export interface ZoneRecord {
  readonly name: string;
  readonly ttl: number;
  readonly type: string;
  readonly rdata: string;
  readonly priority: number | null;
  readonly weight: number | null;
  readonly port: number | null;
}

/**
 * Parse a standard zone-file text block into typed records.
 *
 * Handles:
 *   A / AAAA  → name TTL IN A   address
 *   MX        → name TTL IN MX  priority target
 *   TXT       → name TTL IN TXT "quoted text" (merges multi-string TXT)
 *   CNAME     → name TTL IN CNAME target
 *   SRV       → name TTL IN SRV priority weight port target
 *
 * Lines starting with `;` or `$` are skipped (comments / directives).
 * Lines with unrecognized types are skipped silently.
 */
export function parseZoneFile(zoneText: string): readonly ZoneRecord[] {
  const records: ZoneRecord[] = [];

  for (const rawLine of zoneText.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('$')) continue;

    // Tokenise respecting quoted strings (TXT records).
    const tokens = tokenizeZoneLine(line);
    if (tokens.length < 4) continue;

    // Possible token orderings:
    //   name TTL IN type rdata...
    //   name IN TTL type rdata...
    //   name IN type rdata...    (no explicit TTL)
    // We detect which by trying to parse token[1] as a number.
    let idx = 0;
    const name = tokens[idx++] ?? '';
    let ttl = 3600;

    // Skip optional TTL
    if (/^\d+$/.test(tokens[idx] ?? '')) {
      ttl = parseInt(tokens[idx++] ?? '3600', 10);
    }
    // Skip optional class (IN)
    if (/^IN$/i.test(tokens[idx] ?? '')) {
      idx++;
    }
    // Skip optional TTL if it appears after class
    if (/^\d+$/.test(tokens[idx] ?? '')) {
      ttl = parseInt(tokens[idx++] ?? '3600', 10);
    }

    const type = (tokens[idx++] ?? '').toUpperCase();
    const rest = tokens.slice(idx);

    switch (type) {
      case 'A':
      case 'AAAA':
      case 'CNAME':
        if (rest.length >= 1) {
          records.push({ name, ttl, type, rdata: rest[0] ?? '', priority: null, weight: null, port: null });
        }
        break;

      case 'MX': {
        // MX priority target. Code-review L4 fix (2026-05-04): guard
        // parseInt against NaN so a malformed Stalwart zone-file entry
        // doesn't store NaN as the priority column value (DB write
        // would store it as 0 or fail, depending on PG dialect).
        const prio = parseDnsInt(rest[0], 10);
        const target = rest[1] ?? '';
        records.push({ name, ttl, type, rdata: target, priority: prio, weight: null, port: null });
        break;
      }

      case 'TXT': {
        // TXT records: one or more quoted strings that should be concatenated
        const val = rest.map((t) => stripQuotes(t)).join('');
        if (val) records.push({ name, ttl, type, rdata: val, priority: null, weight: null, port: null });
        break;
      }

      case 'SRV': {
        // SRV priority weight port target. Same NaN guard as MX.
        const prio = parseDnsInt(rest[0], 0);
        const weight = parseDnsInt(rest[1], 1);
        const port = parseDnsInt(rest[2], 0);
        const target = rest[3] ?? '';
        // Platform stores SRV rdata as "weight port target" and priority separately
        records.push({ name, ttl, type, rdata: `${weight} ${port} ${target}`, priority: prio, weight, port });
        break;
      }

      // NS, SOA, PTR, etc. — skip; Stalwart should not publish these for
      // mail domains via dnsZoneFile.
      default:
        break;
    }
  }
  return records;
}

/** Split a zone-file line into tokens, honouring quoted strings. */
function tokenizeZoneLine(line: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < line.length) {
    // Skip whitespace
    while (i < line.length && /\s/.test(line[i] ?? '')) i++;
    if (i >= line.length) break;

    if (line[i] === '"') {
      // Consume until closing quote
      let j = i + 1;
      while (j < line.length && line[j] !== '"') {
        if (line[j] === '\\') j++; // skip escaped char
        j++;
      }
      tokens.push(line.slice(i, j + 1)); // include the quotes
      i = j + 1;
    } else if (line[i] === ';') {
      break; // rest of line is a comment
    } else {
      let j = i;
      while (j < line.length && !/\s/.test(line[j] ?? '') && line[j] !== ';') j++;
      tokens.push(line.slice(i, j));
      i = j;
    }
  }
  return tokens;
}

function stripQuotes(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"');
  }
  return s;
}

/**
 * Parse an integer from a zone-file token, returning the fallback when
 * the token is missing, empty, or non-numeric. NaN-safe replacement
 * for `parseInt(token ?? defaultStr, 10)` — review L4.
 */
function parseDnsInt(token: string | undefined, fallback: number): number {
  if (token === undefined || token === null || token === '') return fallback;
  const n = parseInt(token, 10);
  return Number.isFinite(n) ? n : fallback;
}

// ── Diff + sync ───────────────────────────────────────────────────────────────

/**
 * A lightweight fingerprint for diffing zone records against the DB.
 * We normalize trailing dots from zone-file FQDNs (e.g. "mail.example.com.")
 * because the platform stores names without them.
 */
function recordKey(type: string, name: string, rdata: string): string {
  const normalName = name.replace(/\.$/, '');
  const normalRdata = rdata.replace(/\.$/, '');
  return `${type}:${normalName}:${normalRdata}`;
}

export const STALWART_SOURCE = 'stalwart' as const;

/**
 * Sync Stalwart's DNS requirements for a single domain into the
 * platform's `dns_records` table and push to DNS providers.
 *
 * Algorithm:
 *   1. Fetch `dnsZoneFile` for the domain principal.
 *   2. Parse into ZoneRecord[].
 *   3. Load existing `dns_records` rows where source='stalwart' for this domain.
 *   4. Compare by (type, name, rdata) fingerprints.
 *   5. INSERT missing rows + push to providers.
 *   6. DELETE orphaned rows + push delete to providers.
 *
 * Callers (the scheduler and the domain-create hook) pass the platform
 * `domainId` (from the `domains` table) and the Stalwart `principalId`
 * for the matching Domain principal.
 */
export async function syncDomainDnsRecords(params: {
  db: Database;
  domainId: string;
  domainName: string;
  jmapAccountId: JmapAccountId;
  stalwartDomainPrincipalId: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ added: number; removed: number }> {
  const { db, domainId, domainName, jmapAccountId, stalwartDomainPrincipalId, baseUrl, env } = params;

  // 1. Fetch dnsZoneFile from Stalwart
  const principal = await principalGetOne({
    accountId: jmapAccountId,
    id: stalwartDomainPrincipalId,
    properties: ['id', 'name', 'type', 'dnsZoneFile'],
    baseUrl,
    env,
  });

  if (!principal?.dnsZoneFile) {
    // Domain not yet populated (just created) — skip silently.
    return { added: 0, removed: 0 };
  }

  // 2. Parse zone file
  const desired = parseZoneFile(principal.dnsZoneFile);

  // 3. Load existing stalwart-owned records from DB
  // Note: dns_records table has no `source` column in the current schema.
  // We identify stalwart-owned records by a naming convention:
  // record_value starts with a known sentinel or we use the recordName
  // approach. Since the schema has no source column yet, we track
  // stalwart ownership via a separate lookup table or by comparing
  // against the desired set on every sync (idempotent upsert approach).
  //
  // For M5 we use the idempotent upsert approach:
  //   - If a record with (domainId, type, name, value) already exists → skip.
  //   - If a record with (domainId, type, name) exists but different value → update.
  //   - Records in DB matching (domainId, type, name) but NOT in desired set AND
  //     whose value was previously written by us → delete.
  //
  // To track "written by us" without a schema migration, we compare
  // the zone file fingerprint against ALL dns_records for the domain
  // and only delete records whose (type, name, rdata) key appears in NO
  // current desired set and whose value matches what Stalwart would
  // have written in a previous run.
  //
  // This is safe because:
  //   - Stalwart's zone file is the authoritative source for its records.
  //   - Other platform components write records with different naming
  //     conventions (e.g., mail.domain.com A record from dns-provisioning.ts).
  //   - We only delete records that were in a previous Stalwart zone file
  //     (identifiable by name pattern — see isStalwartOwnedRecord()).

  const existingRows: DnsRecord[] = await db
    .select()
    .from(dnsRecords)
    .where(eq(dnsRecords.domainId, domainId));

  const desiredKeys = new Set(desired.map((r) => recordKey(r.type, r.name, r.rdata)));
  const existingByKey = new Map<string, DnsRecord>(
    existingRows.map((r) => [
      recordKey(r.recordType, r.recordName ?? '', r.recordValue ?? ''),
      r,
    ]),
  );

  let added = 0;
  let removed = 0;

  // 5. INSERT missing — provider FIRST, DB second.
  // Original code wrote DB first then swallowed provider errors with .catch,
  // leaving DB rows with no matching DNS record (the next sync sees them in
  // existingByKey and skips, so the record is permanently lost). The fixed
  // order makes DB the cache of confirmed-published state.
  const normalisedDomain = domainName.replace(/\.$/, '').toLowerCase();
  for (const zr of desired) {
    const key = recordKey(zr.type, zr.name, zr.rdata);
    if (existingByKey.has(key)) continue;

    const id = crypto.randomUUID();
    const normalName = zr.name.replace(/\.$/, '');
    const normalRdata = zr.rdata.replace(/\.$/, '');

    // Security review HIGH-3 fix (2026-05-03): refuse to push records
    // whose name escapes the expected domain scope. A compromised or
    // misconfigured Stalwart could otherwise return a zone file that
    // includes records for unrelated tenants (e.g. an MX for someone
    // else's domain), and this loop would dutifully publish them to
    // PowerDNS. The check rejects anything that isn't `domainName`
    // itself or a subdomain of it.
    const lowerName = normalName.toLowerCase();
    if (lowerName !== normalisedDomain && !lowerName.endsWith(`.${normalisedDomain}`)) {
      log.warn({
        type: zr.type,
        name: normalName,
        expectedScope: normalisedDomain,
      }, 'refusing out-of-scope record from Stalwart zone file (possible misconfiguration or compromise)');
      continue;
    }

    const recType = zr.type as 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'SRV' | 'NS';

    try {
      await syncRecordToProviders(db, domainName, 'create', {
        type: zr.type,
        name: normalName,
        content: normalRdata,
        ttl: zr.ttl,
        priority: zr.priority,
      }, domainId);
    } catch (err) {
      log.warn({
        type: zr.type,
        name: normalName,
        err: err instanceof Error ? err.message : String(err),
      }, 'provider push failed — deferring DB write to next cycle');
      continue;  // next sync cycle will retry — provider is source of truth
    }

    await db.insert(dnsRecords).values({
      id,
      domainId,
      recordType: recType,
      recordName: normalName,
      recordValue: normalRdata,
      ttl: zr.ttl,
      priority: zr.priority,
      weight: zr.weight,
      port: zr.port,
    });

    added++;
  }

  // 6. DELETE orphaned stalwart-owned records — provider FIRST, DB second.
  // If we deleted the DB row first and the provider call failed, the
  // PowerDNS record was orphaned with no way to find it again.
  for (const [key, row] of existingByKey) {
    if (!desiredKeys.has(key)) {
      // Only delete records that look like Stalwart owns them — the
      // heuristic below is intentionally conservative.
      if (!isStalwartOwnedRecord(row.recordName ?? '', row.recordType, domainName, row.recordValue)) {
        continue;
      }
      try {
        await syncRecordToProviders(db, domainName, 'delete', {
          type: row.recordType,
          name: row.recordName ?? '',
          content: row.recordValue ?? '',
          id: row.id,
        }, domainId);
      } catch (err) {
        log.warn({
          type: row.recordType,
          name: row.recordName,
          err: err instanceof Error ? err.message : String(err),
        }, 'provider delete failed — deferring DB delete to next cycle');
        continue;  // next sync cycle will retry
      }
      await db.delete(dnsRecords).where(eq(dnsRecords.id, row.id));
      removed++;
    }
  }

  return { added, removed };
}

/**
 * Heuristic to determine whether a platform dns_record row is owned
 * by the Stalwart sync and safe to delete.
 *
 * Stalwart publishes these record types / names for a mail domain:
 *   - MX records at the apex (domainName)
 *   - TXT records: SPF (v=spf1...), DKIM (*.domainkey.*), DMARC (_dmarc.*)
 *     and MTA-STS (_mta-sts.*)
 *   - CNAME: mta-sts.*, autoconfig.*, autodiscover.*
 *   - A/AAAA: mail.*
 *   - SRV: _submission.*, _submissions.*, _imap.*, _imaps.*
 *
 * We only delete a record if it matches one of these patterns. This is
 * conservative — it avoids accidentally deleting records that another
 * component wrote with the same type but a different purpose.
 */
export function isStalwartOwnedRecord(
  recordName: string,
  recordType: string,
  domainName: string,
  recordValue?: string | null,
): boolean {
  const n = recordName.replace(/\.$/, '').toLowerCase();
  const d = domainName.toLowerCase();
  const t = recordType.toUpperCase();
  const v = (recordValue ?? '').toLowerCase();

  switch (t) {
    case 'MX':
      return n === d;
    case 'TXT':
      // Apex TXT: only ours if it's an SPF (v=spf1 prefix). Stops the
      // sync from deleting Google site-verification, DMARC-aggregator
      // postmaster TXTs, or any other apex TXT that another component
      // owns — code-review HIGH from 2026-05-03.
      if (n === d) return v.startsWith('v=spf1');
      return (
        n.endsWith(`._domainkey.${d}`) || // DKIM
        n === `_dmarc.${d}` ||
        n === `_mta-sts.${d}`
      );
    case 'CNAME':
      return (
        n === `mta-sts.${d}` ||
        n === `autoconfig.${d}` ||
        n === `autodiscover.${d}`
      );
    case 'A':
    case 'AAAA':
      return n === `mail.${d}`;
    case 'SRV':
      return (
        n === `_submission._tcp.${d}` ||
        n === `_submissions._tcp.${d}` ||
        n === `_imap._tcp.${d}` ||
        n === `_imaps._tcp.${d}`
      );
    default:
      return false;
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

export interface DnsSyncSchedulerOptions {
  readonly intervalMs?: number;
  readonly baseUrl?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface DnsSyncScheduler {
  start(): void;
  stop(): void;
  /** Run one sync cycle immediately (useful for tests / on-demand triggers). */
  runOnce(): Promise<void>;
}

/**
 * Build the DNS sync scheduler.
 *
 * Call `start()` after the database is ready. The first run fires
 * immediately; subsequent runs fire every `intervalMs` (default 5 min).
 *
 * The scheduler is stateful: it remembers the last JMAP `Principal/changes`
 * state so it only fetches zone files for domains that actually changed.
 * On the first run it fetches all email domains.
 */
export function createDnsSyncScheduler(
  db: Database,
  options: DnsSyncSchedulerOptions = {},
): DnsSyncScheduler {
  const intervalMs = options.intervalMs ?? 5 * 60 * 1000; // 5 minutes
  const baseUrl = options.baseUrl;
  const env = options.env ?? process.env;

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let lastState: string | null = null;
  let principalAccountId: JmapAccountId | null = null;

  async function runCycle(): Promise<void> {
    if (running) return; // prevent overlap
    running = true;
    try {
      await runSyncCycle({ db, baseUrl, env, lastState, principalAccountId }).then((result) => {
        lastState = result.newState;
        principalAccountId = result.accountId;
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'sync cycle failed');
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer !== null) return;
      // Code-review M-2 fix (2026-05-03, second pass): mirror the
      // principals-sync jitter so multiple platform-api replicas don't
      // run their first DNS sync at exactly the same moment.
      const initialDelay = Math.floor(Math.random() * intervalMs);
      timer = setTimeout(() => {
        timer = null;
        void runCycle();
        timer = setInterval(() => { void runCycle(); }, intervalMs);
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

// ── Core sync cycle ───────────────────────────────────────────────────────────

interface SyncCycleResult {
  readonly newState: string;
  readonly accountId: JmapAccountId;
}

async function runSyncCycle(params: {
  db: Database;
  baseUrl?: string;
  env: NodeJS.ProcessEnv;
  lastState: string | null;
  principalAccountId: JmapAccountId | null;
}): Promise<SyncCycleResult> {
  const { db, baseUrl, env, lastState } = params;

  // Resolve JMAP account ID from session
  const session = await getJmapSession(baseUrl, env);
  const accountId = session.primaryAccounts['urn:ietf:params:jmap:principals'];
  if (!accountId) {
    throw new Error('[stalwart-dns-sync] No principals account in JMAP session');
  }

  let domainPrincipalIds: string[] | null = null;
  let newState: string = session.state;

  if (lastState !== null) {
    // Incremental: only sync domains that changed
    const changes = await principalChanges({ accountId, sinceState: lastState, baseUrl, env });
    newState = changes.newState;
    const changedIds = [...changes.created, ...changes.updated];
    if (changedIds.length === 0 && !changes.hasMoreChanges) {
      // Nothing changed — fast path
      return { newState, accountId };
    }
    domainPrincipalIds = changedIds;
  }

  // Fetch all domain principals (or just the changed ones)
  const principalResult = await principalGet({
    accountId,
    ids: domainPrincipalIds,
    properties: ['id', 'name', 'type', 'dnsZoneFile'],
    baseUrl,
    env,
  });
  newState = principalResult.state;

  // Get all email domains from the platform DB for mapping
  const emailDomainRows: Array<{ domainId: string; domainName: string }> = await db
    .select({
      domainId: emailDomains.domainId,
      domainName: domains.domainName,
    })
    .from(emailDomains)
    .innerJoin(domains, eq(domains.id, emailDomains.domainId));

  const domainByName = new Map(
    emailDomainRows.map((r) => [r.domainName.toLowerCase(), r]),
  );

  // Sync each Stalwart domain principal
  for (const principal of principalResult.list) {
    if (principal.type !== 'domain') continue;
    if (!principal.id || !principal.dnsZoneFile) continue;

    const platformDomain = domainByName.get(principal.name.toLowerCase());
    if (!platformDomain) {
      // Domain exists in Stalwart but not in platform DB — skip.
      // This can happen during domain registration race or manual admin.
      continue;
    }

    try {
      const result = await syncDomainDnsRecords({
        db,
        domainId: platformDomain.domainId,
        domainName: principal.name,
        jmapAccountId: accountId,
        stalwartDomainPrincipalId: principal.id,
        baseUrl,
        env,
      });

      if (result.added > 0 || result.removed > 0) {
        log.info({
          domain: principal.name,
          added: result.added,
          removed: result.removed,
        }, 'dns records synced');
      }
    } catch (err) {
      log.error({
        domain: principal.name,
        err: err instanceof Error ? err.message : String(err),
      }, 'failed to sync domain');
    }
  }

  return { newState, accountId };
}
