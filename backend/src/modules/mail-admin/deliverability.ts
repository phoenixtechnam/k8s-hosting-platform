/**
 * Mail deliverability probes — DNS hygiene, blocklists, certificate SAN
 * match, SMTP banner / EHLO hostname check.
 *
 * These hit *external* infrastructure (recursive resolver + DNSBL
 * providers) so they are inherently slower than the cluster-internal
 * pod / jmap / cert / tcp probes in health.ts. They run in parallel
 * with strict per-query timeouts and never block the rest of
 * getMailHealth() longer than DELIVERABILITY_WALL_TIMEOUT_MS.
 *
 * Severity model (see api-contracts/mail-health.ts):
 *   `ok`       — assertion held
 *   `warning`  — soft-fail; deliverability may degrade for some recipients
 *   `fail`     — assertion failed; mail likely rejected by receivers
 *   `advisory` — informational only; does NOT count against `healthy`
 *   `skipped`  — couldn't run (no hostname, no IPs, network error)
 *
 * The component's own `healthy` flag is true if and only if NO sub-probe
 * has severity `fail`. Warnings, advisories, and skipped do not flip
 * `healthy` — this matches operator intent: a fresh cluster on a brand-
 * new IP often shows up on UCEPROTECT L1 or Backscatterer for the first
 * 24h, and we don't want that to red-light the dashboard. Spamhaus ZEN /
 * Barracuda / SpamCop ARE wired as `fail` though — those genuinely
 * break mail delivery.
 */

import { Resolver } from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import type {
  MailHealthBlocklistProbe,
  MailHealthCertSanProbe,
  MailHealthDeliverabilityComponent,
  MailHealthForwardDnsProbe,
  MailHealthReverseDnsProbe,
  MailHealthSmtpBannerProbe,
} from '@k8s-hosting/api-contracts';

const DELIVERABILITY_WALL_TIMEOUT_MS = 8_000;
// DNS lookups (A/AAAA, PTR) — single authoritative query, fast in
// practice. Kept separate from DNSBL_TIMEOUT_MS so the two can be tuned
// independently if e.g. operators run with a slow recursor.
const DNS_LOOKUP_TIMEOUT_MS = 3_000;
const DNSBL_TIMEOUT_MS = 3_000;
const SMTP_BANNER_TIMEOUT_MS = 5_000;
const TLS_HANDSHAKE_TIMEOUT_MS = 5_000;

// In-cluster Service VIP for SMTP/TLS probes. The platform-api pod can
// reach this directly; the cert served here is the same one the
// external listener serves (Stalwart loads a single cert per protocol).
const STALWART_SERVICE_HOST = 'stalwart-mail.mail.svc.cluster.local';
const STALWART_SMTP_PORT = 25;
const STALWART_SMTPS_PORT = 465;

// 8 reputable IP-based blocklists.
//
// Severity per list reflects the impact-vs-noise tradeoff:
//   - Spamhaus ZEN: industry standard, hard reject by most large MTAs
//   - Barracuda: widely consumed by enterprise spam filters
//   - SpamCop: high-volume aggregator, consumed by many open-source MTAs
//   - SORBS aggregate / PSBL / Mailspike: mid-trust; some receivers act
//     on them, many don't — flag as warning
//   - UCEPROTECT L1 / Backscatterer: noisy, often false-positive, paid
//     removal — flag as advisory so they show up in the modal but don't
//     trip the top-level "Mail server: DEGRADED" banner
//
// `lookupUrl` is what the modal links to so operators can request
// delisting without us having to write a how-to per provider.
const BLOCKLISTS: ReadonlyArray<{
  readonly name: string;
  readonly zone: string;
  readonly listedSeverity: 'fail' | 'warning' | 'advisory';
  readonly lookupUrl: string;
}> = [
  { name: 'Spamhaus ZEN', zone: 'zen.spamhaus.org', listedSeverity: 'fail', lookupUrl: 'https://check.spamhaus.org/' },
  { name: 'Barracuda', zone: 'b.barracudacentral.org', listedSeverity: 'fail', lookupUrl: 'https://www.barracudacentral.org/rbl/removal-request' },
  { name: 'SpamCop', zone: 'bl.spamcop.net', listedSeverity: 'fail', lookupUrl: 'https://www.spamcop.net/bl.shtml' },
  { name: 'SORBS Aggregate', zone: 'dnsbl.sorbs.net', listedSeverity: 'warning', lookupUrl: 'https://www.sorbs.net/lookup.shtml' },
  { name: 'PSBL', zone: 'psbl.surriel.com', listedSeverity: 'warning', lookupUrl: 'https://psbl.org/' },
  { name: 'Mailspike', zone: 'bl.mailspike.net', listedSeverity: 'warning', lookupUrl: 'https://mailspike.org/blacklist.html' },
  { name: 'UCEPROTECT L1', zone: 'dnsbl-1.uceprotect.net', listedSeverity: 'advisory', lookupUrl: 'https://www.uceprotect.net/en/rblcheck.php' },
  { name: 'Backscatterer', zone: 'ips.backscatterer.org', listedSeverity: 'advisory', lookupUrl: 'https://www.backscatterer.org/?target=test' },
];

export interface DeliverabilityDeps {
  /** mail.<apex> or operator override from webmail-settings; null disables probes. */
  readonly hostname: string | null;
  /**
   * Server-role node IPs the cluster believes serve mail. In allServerNodes
   * mode this is the full server-role pool; in thisNodeOnly mode it's the
   * one pinned node's external IP. Empty array → probes return `skipped`.
   */
  readonly serverNodeIps: ReadonlyArray<string>;
  readonly clock?: () => number;
  /** Override for tests: forward DNS resolver (A + AAAA). */
  readonly resolveAddresses?: (hostname: string) => Promise<{ a: string[]; aaaa: string[] }>;
  /** Override for tests: PTR (reverse) DNS resolver. */
  readonly resolvePtr?: (ip: string) => Promise<string[]>;
  /** Override for tests: DNSBL lookup. */
  readonly resolveBlocklist?: (zone: string, queryName: string) => Promise<{ listed: boolean; reasonTxt: string | null }>;
  /** Override for tests: TLS connector for cert SAN probe. */
  readonly tlsConnect?: (host: string, port: number, sni: string, timeoutMs: number) => Promise<{ peerCertificate: tls.PeerCertificate | null; error: string | null }>;
  /** Override for tests: SMTP banner / EHLO exchange. */
  readonly smtpBannerExchange?: (host: string, port: number, ehloName: string, timeoutMs: number) => Promise<{ banner: string | null; ehloLine: string | null; error: string | null }>;
}

// ─────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────

export async function probeDeliverability(deps: DeliverabilityDeps): Promise<MailHealthDeliverabilityComponent> {
  const hostname = deps.hostname?.trim() ?? null;
  const expectedIps = [...deps.serverNodeIps];

  // No hostname configured → everything skipped. Component reports
  // status=not_implemented so the UI shows a friendly "configure mail
  // hostname first" instead of a giant red banner. The summary counts
  // what WOULD have run so the modal's "X skipped" rollup is honest.
  if (!hostname) {
    return notImplementedComponent(
      null,
      expectedIps,
      'No mail hostname configured. Set it under Email Management → Webmail Settings.',
    );
  }
  if (expectedIps.length === 0) {
    return notImplementedComponent(
      hostname,
      [],
      'No server-role node IPs found. Label cluster server nodes with platform.phoenix-host.net/node-role=server, ' +
      'or check that the cluster API is reachable from platform-api.',
    );
  }

  // Wall-timeout the whole bundle so deliverability never blocks the
  // mail-health response longer than DELIVERABILITY_WALL_TIMEOUT_MS.
  // Each sub-probe also enforces its own timeout, so the wall timer is
  // a backstop — under normal conditions all sub-probes return well
  // under it.
  const bundlePromise = runAllProbes(deps, hostname, expectedIps);
  const wallTimeout = new Promise<MailHealthDeliverabilityComponent>((resolve) => {
    setTimeout(() => {
      resolve(wallTimeoutComponent(
        `Deliverability probes exceeded ${DELIVERABILITY_WALL_TIMEOUT_MS}ms wall timeout. ` +
        'Check cluster DNS resolver health (e.g. coredns) and outbound DNS ACLs.',
      ));
    }, DELIVERABILITY_WALL_TIMEOUT_MS).unref?.();
  });
  return Promise.race([bundlePromise, wallTimeout]);
}

async function runAllProbes(
  deps: DeliverabilityDeps,
  hostname: string,
  expectedIps: ReadonlyArray<string>,
): Promise<MailHealthDeliverabilityComponent> {
  const [forwardDns, reverseDns, blocklists, certSanMatch, smtpBanner] = await Promise.all([
    probeForwardDns(deps, hostname, expectedIps),
    probeReverseDnsAll(deps, hostname, expectedIps),
    probeBlocklistsAll(deps, expectedIps),
    probeCertSan(deps, hostname),
    probeSmtpBanner(deps, hostname),
  ]);

  const subProbes: ReadonlyArray<{ severity: string }> = [
    forwardDns,
    ...reverseDns,
    ...blocklists,
    certSanMatch,
    smtpBanner,
  ];
  const summary = { ok: 0, warning: 0, fail: 0, advisory: 0, skipped: 0 };
  for (const p of subProbes) {
    if (p.severity in summary) {
      summary[p.severity as keyof typeof summary] += 1;
    }
  }

  const healthy = summary.fail === 0;
  const errorLine = healthy
    ? null
    : `${summary.fail} deliverability failure${summary.fail === 1 ? '' : 's'} — open Details to inspect`;

  return {
    healthy,
    error: errorLine,
    status: 'ok',
    hostname,
    expectedMailIps: [...expectedIps],
    forwardDns,
    reverseDns,
    blocklists,
    certSanMatch,
    smtpBanner,
    summary,
  };
}

// Number of sub-probes that would have run had the precondition (hostname
// + serverNodeIps) been satisfied: 1 forward DNS + N reverse DNS + N×8
// blocklists + 1 cert SAN + 1 SMTP banner. Used by notImplementedComponent
// so the summary rollup is honest about what was elided.
function expectedSubProbeCount(serverNodeIps: ReadonlyArray<string>): number {
  const ipCount = serverNodeIps.length;
  return 1 + ipCount + (ipCount * BLOCKLISTS.length) + 1 + 1;
}

function notImplementedComponent(
  hostname: string | null,
  serverNodeIps: ReadonlyArray<string>,
  reason: string,
): MailHealthDeliverabilityComponent {
  const skipped = expectedSubProbeCount(serverNodeIps);
  return {
    healthy: true,
    error: null,
    status: 'not_implemented',
    hostname,
    expectedMailIps: [...serverNodeIps],
    forwardDns: {
      severity: 'skipped',
      assertion: 'Mail hostname resolves to all server-role node IPs',
      actual: null,
      expected: null,
      remediation: reason,
      hostname: hostname ?? '',
      resolvedIps: [],
      expectedIps: [...serverNodeIps],
      missingIps: [],
      extraIps: [],
    },
    reverseDns: [],
    blocklists: [],
    certSanMatch: null,
    smtpBanner: null,
    summary: { ok: 0, warning: 0, fail: 0, advisory: 0, skipped },
  };
}

function wallTimeoutComponent(reason: string): MailHealthDeliverabilityComponent {
  return notImplementedComponent(null, [], reason);
}

// ─────────────────────────────────────────────────────────────────────
// Forward DNS — does mail.<apex> resolve to every server-role node IP?
// ─────────────────────────────────────────────────────────────────────

async function probeForwardDns(
  deps: DeliverabilityDeps,
  hostname: string,
  expectedIps: ReadonlyArray<string>,
): Promise<MailHealthForwardDnsProbe> {
  const resolveAddrs = deps.resolveAddresses ?? defaultResolveAddresses;
  let resolvedIps: string[] = [];
  let resolveErr: string | null = null;
  try {
    const { a, aaaa } = await withTimeout(
      resolveAddrs(hostname),
      DNS_LOOKUP_TIMEOUT_MS,
      `Forward DNS lookup for ${hostname} timed out`,
    );
    resolvedIps = [...a, ...aaaa];
  } catch (err) {
    resolveErr = (err as Error).message ?? String(err);
  }

  const expectedSet = new Set(expectedIps);
  const resolvedSet = new Set(resolvedIps);
  const missingIps = expectedIps.filter((ip) => !resolvedSet.has(ip));
  const extraIps = resolvedIps.filter((ip) => !expectedSet.has(ip));

  if (resolveErr) {
    return {
      severity: 'fail',
      assertion: `${hostname} resolves to all server-role node IPs`,
      actual: `DNS lookup failed: ${resolveErr}`,
      expected: expectedIps.join(', '),
      remediation:
        `Could not resolve ${hostname}. Verify the A record is published at your DNS provider ` +
        'and that the recursive resolver (coredns / host /etc/resolv.conf) can reach the authoritative server. ' +
        'In dev/staging this often means a missing /etc/hosts entry.',
      hostname,
      resolvedIps: [],
      expectedIps: [...expectedIps],
      missingIps: [...expectedIps],
      extraIps: [],
    };
  }

  if (missingIps.length === 0 && extraIps.length === 0) {
    return {
      severity: 'ok',
      assertion: `${hostname} resolves to all server-role node IPs`,
      actual: resolvedIps.join(', '),
      expected: expectedIps.join(', '),
      remediation: null,
      hostname,
      resolvedIps,
      expectedIps: [...expectedIps],
      missingIps: [],
      extraIps: [],
    };
  }

  const isFail = missingIps.length > 0;
  const remediation = isFail
    ? `Add A record(s) for ${missingIps.join(', ')} to ${hostname} at your DNS provider. ` +
      'Without this, MX-style routing and reverse-DNS / FCrDNS checks will mismatch and receivers will defer or reject mail.'
    : `${hostname} resolves to ${extraIps.join(', ')} which are NOT cluster server-role nodes. ` +
      'Remove the stale A records, or update the cluster node-role labels if those IPs are intended mail nodes.';

  return {
    severity: isFail ? 'fail' : 'warning',
    assertion: `${hostname} resolves to all server-role node IPs`,
    actual: resolvedIps.length > 0 ? resolvedIps.join(', ') : '(no records)',
    expected: expectedIps.join(', '),
    remediation,
    hostname,
    resolvedIps,
    expectedIps: [...expectedIps],
    missingIps,
    extraIps,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Reverse DNS (FCrDNS) — does each IP's PTR resolve back to the mail hostname?
// ─────────────────────────────────────────────────────────────────────

async function probeReverseDnsAll(
  deps: DeliverabilityDeps,
  hostname: string,
  expectedIps: ReadonlyArray<string>,
): Promise<MailHealthReverseDnsProbe[]> {
  return Promise.all(expectedIps.map((ip) => probeReverseDnsOne(deps, hostname, ip)));
}

async function probeReverseDnsOne(
  deps: DeliverabilityDeps,
  hostname: string,
  ip: string,
): Promise<MailHealthReverseDnsProbe> {
  const resolvePtr = deps.resolvePtr ?? defaultResolvePtr;
  let ptrRecords: string[] = [];
  let err: string | null = null;
  try {
    ptrRecords = await withTimeout(
      resolvePtr(ip),
      DNS_LOOKUP_TIMEOUT_MS,
      `Reverse DNS lookup for ${ip} timed out`,
    );
  } catch (e) {
    err = (e as Error).message ?? String(e);
  }

  // Normalise trailing dot so comparison is robust against dig vs nslookup output.
  const norm = (s: string) => s.replace(/\.$/, '').toLowerCase();
  const expectedNorm = norm(hostname);
  const ptrsNorm = ptrRecords.map(norm);
  const fcrdnsOk = ptrsNorm.includes(expectedNorm);

  if (err) {
    return {
      severity: 'fail',
      assertion: `PTR for ${ip} resolves to ${hostname}`,
      actual: `PTR lookup failed: ${err}`,
      expected: hostname,
      remediation:
        `No PTR record for ${ip}. Configure reverse DNS at the IP's network provider (Hetzner/AWS/etc.) ` +
        `to ${hostname}. Without PTR, large mailbox providers (Gmail, Outlook, Apple) will reject or quarantine mail.`,
      ip,
      ptrRecords: [],
      expectedPtr: hostname,
      fcrdnsOk: false,
    };
  }

  if (fcrdnsOk) {
    return {
      severity: 'ok',
      assertion: `PTR for ${ip} resolves to ${hostname}`,
      actual: ptrRecords.join(', '),
      expected: hostname,
      remediation: null,
      ip,
      ptrRecords,
      expectedPtr: hostname,
      fcrdnsOk: true,
    };
  }

  return {
    severity: 'fail',
    assertion: `PTR for ${ip} resolves to ${hostname}`,
    actual: ptrRecords.length > 0 ? ptrRecords.join(', ') : '(no records)',
    expected: hostname,
    remediation:
      `PTR for ${ip} returns ${ptrRecords.join(', ') || '(nothing)'} instead of ${hostname}. ` +
      'Update reverse DNS at your IP provider to match. Forward+reverse DNS mismatch (FCrDNS failure) is one of the top ' +
      'three reasons receivers tempfail outbound mail.',
    ip,
    ptrRecords,
    expectedPtr: hostname,
    fcrdnsOk: false,
  };
}

// ─────────────────────────────────────────────────────────────────────
// DNSBL — for each (ip, blocklist) check if the IP is listed.
// ─────────────────────────────────────────────────────────────────────

async function probeBlocklistsAll(
  deps: DeliverabilityDeps,
  expectedIps: ReadonlyArray<string>,
): Promise<MailHealthBlocklistProbe[]> {
  const tasks: Promise<MailHealthBlocklistProbe>[] = [];
  for (const ip of expectedIps) {
    for (const bl of BLOCKLISTS) {
      tasks.push(probeBlocklistOne(deps, ip, bl));
    }
  }
  return Promise.all(tasks);
}

async function probeBlocklistOne(
  deps: DeliverabilityDeps,
  ip: string,
  bl: typeof BLOCKLISTS[number],
): Promise<MailHealthBlocklistProbe> {
  const queryName = blocklistQueryName(ip, bl.zone);
  const resolveBl = deps.resolveBlocklist ?? defaultResolveBlocklist;
  try {
    const { listed, reasonTxt } = await withTimeout(
      resolveBl(bl.zone, queryName),
      DNSBL_TIMEOUT_MS,
      `${bl.name} lookup timed out`,
    );
    if (!listed) {
      return {
        severity: 'ok',
        assertion: `${ip} not listed on ${bl.name}`,
        actual: 'not listed',
        expected: 'not listed',
        remediation: null,
        ip,
        list: bl.name,
        zone: bl.zone,
        listed: false,
        reasonTxt: null,
        lookupUrl: bl.lookupUrl,
      };
    }
    return {
      severity: bl.listedSeverity,
      assertion: `${ip} not listed on ${bl.name}`,
      actual: reasonTxt ? `listed: ${reasonTxt}` : 'listed',
      expected: 'not listed',
      remediation:
        `${ip} is listed on ${bl.name}. ` +
        (bl.listedSeverity === 'fail'
          ? 'This blocklist is consumed by major receivers (Gmail, Outlook, etc.) — expect bounce/defer. '
          : bl.listedSeverity === 'warning'
            ? 'This blocklist is consumed by some receivers — expect partial delivery degradation. '
            : 'This blocklist is noisy and rarely acted on — informational. ') +
        `Request delisting at ${bl.lookupUrl}.`,
      ip,
      list: bl.name,
      zone: bl.zone,
      listed: true,
      reasonTxt,
      lookupUrl: bl.lookupUrl,
    };
  } catch (err) {
    // DNSBL lookup errors (NXDOMAIN, SERVFAIL, timeout) are common and
    // don't indicate listing. Report as `skipped` rather than `fail` so
    // a flaky DNSBL provider doesn't red-light the dashboard.
    return {
      severity: 'skipped',
      assertion: `${ip} not listed on ${bl.name}`,
      actual: `lookup error: ${(err as Error).message ?? String(err)}`,
      expected: 'not listed',
      remediation:
        `Lookup against ${bl.zone} failed. The provider may be down, or your recursive resolver may be ` +
        'rate-limited by it. This is not a listing — but if multiple DNSBLs report errors, check coredns health.',
      ip,
      list: bl.name,
      zone: bl.zone,
      listed: false,
      reasonTxt: null,
      lookupUrl: bl.lookupUrl,
    };
  }
}

// IPv4 → reversed octets + zone. IPv6 → reversed nibbles + zone (RFC 5782).
export function blocklistQueryName(ip: string, zone: string): string {
  // Reject zone-ID-suffixed link-local IPv6 addresses (e.g. `fe80::1%eth0`):
  // expandIPv6 would silently produce a garbled query. Operators don't put
  // link-local addresses on server nodes, so the safe move is to throw and
  // let the outer catch report the probe as `skipped`.
  if (ip.includes('%')) throw new Error(`Invalid IP (contains zone ID): ${ip}`);
  if (ip.includes(':')) {
    // Expand v6, drop colons, reverse nibbles. This is simplified — real
    // RFC 5782 IPv6 DNSBL queries are rare in practice; we just need
    // SOMETHING the resolver won't reject. If the provider doesn't
    // support IPv6, it'll NXDOMAIN which we treat as "not listed".
    const expanded = expandIPv6(ip).replace(/:/g, '');
    const reversed = expanded.split('').reverse().join('.');
    return `${reversed}.${zone}`;
  }
  const octets = ip.split('.');
  if (octets.length !== 4) throw new Error(`Invalid IPv4: ${ip}`);
  return `${octets.reverse().join('.')}.${zone}`;
}

function expandIPv6(ip: string): string {
  // Minimal expansion: `::` becomes the right number of `:0` groups.
  // Sufficient for blocklistQueryName's reverse-nibble lookup.
  if (!ip.includes('::')) return ip;
  const [head, tail] = ip.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  return [...headGroups, ...Array(missing).fill('0'), ...tailGroups]
    .map((g) => g.padStart(4, '0'))
    .join(':');
}

// ─────────────────────────────────────────────────────────────────────
// Cert SAN match — does the cert served on smtps include the mail hostname?
// ─────────────────────────────────────────────────────────────────────

async function probeCertSan(deps: DeliverabilityDeps, hostname: string): Promise<MailHealthCertSanProbe> {
  const tlsConn = deps.tlsConnect ?? defaultTlsConnect;
  try {
    // No outer withTimeout: `defaultTlsConnect` carries its OWN timer
    // that calls `socket.destroy()` on expiry. Wrapping it again
    // would let the outer timer reject before the inner one closes
    // the socket, leaking the descriptor until GC. Test overrides
    // are pure async functions with no sockets so they don't leak.
    const { peerCertificate, error } = await tlsConn(
      STALWART_SERVICE_HOST,
      STALWART_SMTPS_PORT,
      hostname,
      TLS_HANDSHAKE_TIMEOUT_MS,
    );
    if (error || !peerCertificate) {
      return {
        severity: 'fail',
        assertion: `Cert served on smtps (465) includes ${hostname} in SAN`,
        actual: error ?? 'no certificate received',
        expected: `SAN entry for ${hostname}`,
        remediation:
          'Could not retrieve cert via in-cluster TLS handshake. Check Stalwart pod readiness and ' +
          'verify cert-manager has issued a cert (kubectl get certificate -n mail). If the cert is missing, ' +
          'check the ClusterIssuer rate limits.',
        hostname,
        sanDnsNames: [],
        matched: false,
      };
    }
    const sanRaw = peerCertificate.subjectaltname ?? '';
    const sanDns = parseSanDnsNames(sanRaw);
    const matched = matchSan(hostname, sanDns);

    if (matched) {
      return {
        severity: 'ok',
        assertion: `Cert served on smtps (465) includes ${hostname} in SAN`,
        actual: `SAN: ${sanDns.join(', ') || '(none)'}`,
        expected: `SAN entry for ${hostname}`,
        remediation: null,
        hostname,
        sanDnsNames: sanDns,
        matched: true,
      };
    }
    return {
      severity: 'fail',
      assertion: `Cert served on smtps (465) includes ${hostname} in SAN`,
      actual: sanDns.length > 0 ? `SAN: ${sanDns.join(', ')}` : '(empty SAN)',
      expected: `SAN entry for ${hostname}`,
      remediation:
        `The cert served by Stalwart does not include ${hostname} in its SubjectAltName. ` +
        'Clients connecting with SMTPS/IMAPS will fail TLS verification (TLS_REQUIRE_NAME_MATCH). ' +
        'Add the hostname to the Certificate resource in k8s/base/stalwart-mail and trigger a renewal.',
      hostname,
      sanDnsNames: sanDns,
      matched: false,
    };
  } catch (err) {
    return {
      severity: 'fail',
      assertion: `Cert served on smtps (465) includes ${hostname} in SAN`,
      actual: `probe error: ${(err as Error).message ?? String(err)}`,
      expected: `SAN entry for ${hostname}`,
      remediation:
        'TLS probe failed before a cert could be inspected. This usually means port 465 is not listening or ' +
        'a NetworkPolicy is denying egress from platform-api → stalwart-mail.mail.svc. Check the TCP probe row.',
      hostname,
      sanDnsNames: [],
      matched: false,
    };
  }
}

/** Parse Node's `subjectaltname` string ("DNS:a, DNS:b, IP Address:1.2.3.4") → DNS names. */
export function parseSanDnsNames(san: string): string[] {
  return san
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('DNS:'))
    .map((s) => s.slice(4).trim().toLowerCase());
}

/** Match hostname against SAN entries with wildcard support (RFC 6125 §6.4). */
export function matchSan(hostname: string, sanDnsNames: ReadonlyArray<string>): boolean {
  const h = hostname.toLowerCase();
  for (const san of sanDnsNames) {
    if (san === h) return true;
    if (san.startsWith('*.')) {
      const suffix = san.slice(1); // ".example.com"
      const dotIdx = h.indexOf('.');
      // Wildcard matches exactly one label: hostname must have a dot,
      // and the part AFTER the first label must equal the suffix.
      if (dotIdx > 0 && h.slice(dotIdx) === suffix) return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────
// SMTP banner / EHLO — does the listener advertise the mail hostname?
// ─────────────────────────────────────────────────────────────────────

async function probeSmtpBanner(deps: DeliverabilityDeps, hostname: string): Promise<MailHealthSmtpBannerProbe> {
  const exchange = deps.smtpBannerExchange ?? defaultSmtpBannerExchange;
  try {
    // No outer withTimeout: same reasoning as probeCertSan — the inner
    // implementation calls `socket.destroy()` on its own timer, so an
    // extra outer wrapper would leak the descriptor on slow paths.
    const { banner, ehloLine, error } = await exchange(
      STALWART_SERVICE_HOST,
      STALWART_SMTP_PORT,
      'mail-health-probe.local',
      SMTP_BANNER_TIMEOUT_MS,
    );
    if (error) {
      return {
        severity: 'skipped',
        assertion: `SMTP listener advertises ${hostname} in 220 banner + 250 EHLO`,
        actual: error,
        expected: `220 ${hostname} ...` + ` / 250-${hostname}`,
        remediation:
          'Could not open a TCP connection to port 25 on the in-cluster Stalwart Service. Check the TCP-probe ' +
          'row above first — if 25 is blocked, NetworkPolicy or kube-proxy is the cause, not Stalwart.',
        hostname,
        bannerHostname: null,
        ehloHostname: null,
        bannerMatches: false,
        ehloMatches: false,
      };
    }

    const bannerHost = extractBannerHostname(banner);
    const ehloHost = extractEhloHostname(ehloLine);
    const norm = (s: string | null) => s?.toLowerCase().replace(/\.$/, '') ?? null;
    const expectedNorm = norm(hostname)!;
    const bannerMatches = norm(bannerHost) === expectedNorm;
    const ehloMatches = norm(ehloHost) === expectedNorm;

    if (bannerMatches && ehloMatches) {
      return {
        severity: 'ok',
        assertion: `SMTP listener advertises ${hostname} in 220 banner + 250 EHLO`,
        actual: `banner=${bannerHost}, ehlo=${ehloHost}`,
        expected: `banner=${hostname}, ehlo=${hostname}`,
        remediation: null,
        hostname,
        bannerHostname: bannerHost,
        ehloHostname: ehloHost,
        bannerMatches: true,
        ehloMatches: true,
      };
    }

    return {
      severity: 'fail',
      assertion: `SMTP listener advertises ${hostname} in 220 banner + 250 EHLO`,
      actual: `banner=${bannerHost ?? '(none)'}, ehlo=${ehloHost ?? '(none)'}`,
      expected: `banner=${hostname}, ehlo=${hostname}`,
      remediation:
        `Stalwart's banner/EHLO hostname (${bannerHost ?? '?'} / ${ehloHost ?? '?'}) does not match ${hostname}. ` +
        'Receivers cross-check the EHLO name against the connecting IP\'s PTR and SPF — a mismatch causes SPF ' +
        'failures and outbound rejections. Fix via JMAP: set defaultHostname in SystemSettings.',
      hostname,
      bannerHostname: bannerHost,
      ehloHostname: ehloHost,
      bannerMatches,
      ehloMatches,
    };
  } catch (err) {
    return {
      severity: 'skipped',
      assertion: `SMTP listener advertises ${hostname} in 220 banner + 250 EHLO`,
      actual: `probe error: ${(err as Error).message ?? String(err)}`,
      expected: `banner=${hostname}, ehlo=${hostname}`,
      remediation:
        'SMTP banner probe failed unexpectedly. Check the TCP probe row first; if port 25 is reachable, ' +
        'this is likely a Stalwart-side issue.',
      hostname,
      bannerHostname: null,
      ehloHostname: null,
      bannerMatches: false,
      ehloMatches: false,
    };
  }
}

/** Pull the hostname out of `220 mail.example.com ESMTP Stalwart 0.16`. */
export function extractBannerHostname(banner: string | null): string | null {
  if (!banner) return null;
  const m = banner.match(/^220[ -]([\w.-]+)/);
  return m ? m[1] : null;
}

/** Pull the hostname out of the first EHLO 250 line: `250-mail.example.com offers ...`. */
export function extractEhloHostname(ehloLine: string | null): string | null {
  if (!ehloLine) return null;
  const m = ehloLine.match(/^250[ -]([\w.-]+)/);
  return m ? m[1] : null;
}

// ─────────────────────────────────────────────────────────────────────
// Default implementations of the dep overrides (used in production).
// ─────────────────────────────────────────────────────────────────────

async function defaultResolveAddresses(hostname: string): Promise<{ a: string[]; aaaa: string[] }> {
  const r = new Resolver();
  const [a, aaaa] = await Promise.all([
    r.resolve4(hostname).catch(() => [] as string[]),
    r.resolve6(hostname).catch(() => [] as string[]),
  ]);
  return { a, aaaa };
}

async function defaultResolvePtr(ip: string): Promise<string[]> {
  const r = new Resolver();
  return r.reverse(ip);
}

async function defaultResolveBlocklist(zone: string, queryName: string): Promise<{ listed: boolean; reasonTxt: string | null }> {
  const r = new Resolver();
  // Listed iff the A record exists. The convention is `127.0.0.X` codes
  // but presence alone is enough for our reporting.
  try {
    const records = await r.resolve4(queryName);
    if (records.length === 0) return { listed: false, reasonTxt: null };
    let reasonTxt: string | null = null;
    try {
      const txts = await r.resolveTxt(queryName);
      reasonTxt = txts.flat().join(' ').slice(0, 200) || null;
    } catch {
      // TXT not present — that's fine, we still know it's listed.
    }
    return { listed: true, reasonTxt };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTFOUND') {
      // NXDOMAIN = not listed. This is the canonical clean-IP result
      // for all the IP-based DNSBLs in this module's list.
      return { listed: false, reasonTxt: null };
    }
    // ENODATA (NOERROR with empty answer section) is NOT NXDOMAIN —
    // it can indicate resolver-side filtering, a misconfigured zone,
    // or a transient anomaly. Treating it as "clean" would be a false
    // negative for DNSBLs that publish a CNAME-only / TXT-only record
    // for listed IPs. Bubble it up so the outer catch reports the
    // probe as `skipped` (operator can re-check or investigate the
    // resolver) rather than silently green-lighting.
    throw err; // SERVFAIL / REFUSED / timeout / ENODATA → bubble up
  }
}

function defaultTlsConnect(
  host: string,
  port: number,
  sni: string,
  timeoutMs: number,
): Promise<{ peerCertificate: tls.PeerCertificate | null; error: string | null }> {
  return new Promise((resolve) => {
    // We do NOT verify the cert chain here — the goal is to inspect the
    // cert, not to enforce trust. The platform-api pod is also unlikely
    // to have the LE root chain mounted in test envs.
    // No ALPN: port 465 is implicit-TLS and the ALPN protocol label is
    // not standardised for SMTPS; sending one risks unnecessary
    // handshake variability. rejectUnauthorized:false is intentional —
    // the goal is to INSPECT the served cert (SAN match), not enforce
    // chain trust. Target is a hardcoded cluster-DNS name, so MitM
    // would require cluster-DNS compromise (already within blast
    // radius). No credentials are sent over this socket.
    const socket = tls.connect({ host, port, servername: sni, rejectUnauthorized: false });
    let settled = false;
    const settle = (result: { peerCertificate: tls.PeerCertificate | null; error: string | null }) => {
      if (settled) return;
      settled = true;
      try { socket.end(); } catch { /* ignore */ }
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(result);
    };
    const timer = setTimeout(() => settle({ peerCertificate: null, error: 'tls handshake timeout' }), timeoutMs);
    timer.unref?.();
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate(false);
      settle({ peerCertificate: Object.keys(cert).length > 0 ? cert : null, error: null });
    });
    socket.once('error', (err) => settle({ peerCertificate: null, error: err.message ?? String(err) }));
  });
}

function defaultSmtpBannerExchange(
  host: string,
  port: number,
  ehloName: string,
  timeoutMs: number,
): Promise<{ banner: string | null; ehloLine: string | null; error: string | null }> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    let banner: string | null = null;
    let ehloLine: string | null = null;
    let buffer = '';
    let state: 'await-banner' | 'await-ehlo' | 'done' = 'await-banner';

    const settle = (error: string | null) => {
      if (settled) return;
      settled = true;
      try { socket.write('QUIT\r\n'); } catch { /* ignore */ }
      try { socket.end(); } catch { /* ignore */ }
      try { socket.destroy(); } catch { /* ignore */ }
      resolve({ banner, ehloLine, error });
    };
    const timer = setTimeout(() => settle('smtp probe timeout'), timeoutMs);
    timer.unref?.();

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      // SMTP uses CRLF; multi-line replies have `-` after the code on
      // continuation lines, ` ` (space) on the final line. We grab the
      // first line in each state and advance.
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line) continue;
        if (state === 'await-banner' && line.startsWith('220')) {
          banner = line;
          state = 'await-ehlo';
          socket.write(`EHLO ${ehloName}\r\n`);
        } else if (state === 'await-ehlo' && /^250[ -]/.test(line)) {
          if (!ehloLine) ehloLine = line;
          // A line starting `250 ` (space, not dash) marks end-of-ehlo.
          if (/^250 /.test(line)) {
            state = 'done';
            settle(null);
            return;
          }
        }
      }
    });
    socket.once('error', (err) => settle(err.message ?? String(err)));
    socket.once('close', () => {
      if (!settled) settle(state === 'done' ? null : 'connection closed before EHLO completed');
    });
  });
}

// ─────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg)), ms);
    timer.unref?.();
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}
