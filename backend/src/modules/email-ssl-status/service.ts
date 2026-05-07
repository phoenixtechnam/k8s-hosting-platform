/**
 * SSL/TLS status probe for Stalwart's mail listeners.
 *
 * For each mail port (25 STARTTLS / 465 implicit / 587 STARTTLS /
 * 143 STARTTLS / 993 implicit / 4190 STARTTLS), opens a connection
 * from the platform-api pod to Stalwart's in-cluster Service and
 * reports the cert that Stalwart presents (subject, issuer, SAN list,
 * validity window, TLS protocol + cipher). Used by the admin Email
 * Settings UI to give operators a one-glance view of the mail
 * server's TLS posture without leaving the panel.
 *
 * Why in-cluster (vs externally probing each node external IP):
 *   - Avoids per-node-IP enumeration headaches (round-robin DNS,
 *     externalIPs lists)
 *   - Matches the trust path mail clients use (clients connect by
 *     hostname → DNS → Stalwart pod, with SNI auth-routing on
 *     Stalwart's side; cluster-internal probe with the right SNI
 *     reproduces the same handshake)
 *   - One Service hop is cheaper than six external hops
 *   - Stalwart's `x:AllowedIp` rows seeded by bootstrap-plan cover
 *     the cluster pod CIDR, so the probe doesn't trigger the
 *     auto-portScanning ban
 *
 * Caching:
 *   - 30s TTL keyed by hostname so a freshly-rendered admin page
 *     hits the cache rather than re-running 6 TCP+TLS handshakes
 *   - Cache is per-process (no Redis) — adequate for a low-fan-out
 *     admin operation
 */

import * as net from 'node:net';
import * as tls from 'node:tls';

const STALWART_SERVICE = 'stalwart-mail-v016.mail.svc.cluster.local';

export const PROBE_TIMEOUT_MS = 5000;
export const CACHE_TTL_MS = 30_000;

export type ListenerKind =
  | 'smtp'           // port 25  — STARTTLS
  | 'submissions'    // port 465 — implicit TLS
  | 'submission'     // port 587 — STARTTLS
  | 'imap'           // port 143 — STARTTLS
  | 'imaps'          // port 993 — implicit TLS
  | 'managesieve'    // port 4190 — STARTTLS
  | 'webmail-https'; // port 443 — implicit TLS, NOT Stalwart — Roundcube via nginx-ingress

export interface CertInfo {
  readonly subject: string;
  readonly issuer: string;
  readonly subjectAlternativeNames: readonly string[];
  readonly notBefore: string; // ISO-8601
  readonly notAfter: string;  // ISO-8601
  readonly daysUntilExpiry: number;
  readonly serialNumber: string;
  readonly fingerprintSha256: string;
}

export interface ListenerStatus {
  readonly listener: ListenerKind;
  readonly port: number;
  readonly host: string;            // SNI hostname used for the probe
  readonly tlsMode: 'implicit' | 'starttls';
  readonly connected: boolean;
  readonly tlsProtocol: string | null;
  readonly cipher: string | null;
  readonly cert: CertInfo | null;
  readonly error: string | null;
  readonly durationMs: number;
}

interface PortSpec {
  readonly listener: ListenerKind;
  readonly port: number;
  readonly tlsMode: 'implicit' | 'starttls';
  readonly starttlsCommand?: 'smtp' | 'imap' | 'managesieve';
}

const ALL_PORTS: readonly PortSpec[] = [
  { listener: 'smtp',         port: 25,   tlsMode: 'starttls', starttlsCommand: 'smtp' },
  { listener: 'submissions',  port: 465,  tlsMode: 'implicit' },
  { listener: 'submission',   port: 587,  tlsMode: 'starttls', starttlsCommand: 'smtp' },
  { listener: 'imap',         port: 143,  tlsMode: 'starttls', starttlsCommand: 'imap' },
  { listener: 'imaps',        port: 993,  tlsMode: 'implicit' },
  { listener: 'managesieve',  port: 4190, tlsMode: 'starttls', starttlsCommand: 'managesieve' },
];

interface CacheEntry {
  readonly statuses: readonly ListenerStatus[];
  readonly fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

// Stampede guard: stores the in-flight Promise for a hostname so
// concurrent callers all await the SAME probe rather than each
// firing their own 6-handshake fan-out (12 sockets if two callers
// race). The promise is removed from this map as soon as it
// settles, so the next post-cache-expiry caller starts a fresh
// probe.
const inFlight = new Map<string, Promise<readonly ListenerStatus[]>>();

export function clearSslStatusCache(): void {
  cache.clear();
  inFlight.clear();
}

export interface ProbeOptions {
  /** Override the in-cluster service hostname (test injection). */
  readonly serviceHost?: string;
  /** Skip cache (for forced refresh). */
  readonly bypassCache?: boolean;
  /**
   * If set, append a webmail HTTPS probe (TLS handshake on
   * webmailHost:443) to the listener list. The probe goes through
   * the same nginx-ingress path that real browsers use, so it
   * catches the "fake-cert fallback" failure mode that bit
   * webmail.staging.phoenix-host.net on 2026-05-07.
   */
  readonly webmailHost?: string;
}

/**
 * Probe all mail listeners; results are returned in declaration order
 * (25 → 465 → 587 → 143 → 993 → 4190). Probes run in parallel.
 */
export async function probeAllListeners(
  serverHostname: string,
  options: ProbeOptions = {},
): Promise<readonly ListenerStatus[]> {
  // Cache key includes webmailHost so a status row for one mail
  // hostname + webmail-A doesn't get reused when the operator
  // rotates webmail to webmail-B (the cached row would silently
  // serve the stale webmail-A handshake until TTL expires).
  // The `|` separator is safe: RFC-1123 hostnames cannot contain
  // it (label regex is `[a-z0-9-]`) so collision with a real host
  // is impossible.
  const cacheKey = options.webmailHost
    ? `${serverHostname}|${options.webmailHost}`
    : serverHostname;
  if (!options.bypassCache) {
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.statuses;
    }
    // Stampede guard: if a probe is already in-flight for this
    // hostname, await it instead of starting a duplicate fan-out.
    const pending = inFlight.get(cacheKey);
    if (pending) return pending;
  }

  const target = options.serviceHost ?? STALWART_SERVICE;

  // Stampede guard ALSO covers bypassCache=true (security-reviewer
  // HIGH-fix). Without this, N concurrent admin users each clicking
  // "Refresh" would each fan out 6 sockets — N×6 simultaneous TLS
  // handshakes against Stalwart, fighting for the same listeners.
  // The semantic of bypassCache=true is "give me FRESH data" — sharing
  // a fresh in-flight probe satisfies that intent.
  const existing = inFlight.get(cacheKey);
  if (existing) return existing;

  const promise = (async (): Promise<readonly ListenerStatus[]> => {
    const results = await Promise.all(
      ALL_PORTS.map((spec) => probeListener(target, serverHostname, spec)),
    );

    // Webmail HTTPS probe: webmail.${DOMAIN}:443 → nginx-ingress →
    // Roundcube. NOT Stalwart — different cert (cert-manager-issued
    // for the webmail hostname), different ingress path. Probe the
    // public hostname directly because the failure mode we caught
    // on 2026-05-07 (nginx-ingress fake-cert fallback) is invisible
    // from inside the cluster.
    //
    // OPERATOR NOTE for egress-restricted clusters: this probe goes
    // OUT to the public Internet (DNS round-robin → external IP
    // → back to the cluster's nginx-ingress). If the platform-api
    // pod's NetworkPolicy / firewall blocks egress to the cluster's
    // own external IPs, the probe will time out after PROBE_TIMEOUT_MS
    // and the row will render with `connected:false, error: tls
    // timeout`. That's a false-negative for the cert state — the cert
    // may be perfectly valid, the operator just can't reach it from
    // inside. To suppress the row entirely, leave webmailHost
    // unconfigured or set the platform-wide default webmail URL to
    // empty in admin Email Settings.
    if (options.webmailHost) {
      const wm = await probeListener(options.webmailHost, options.webmailHost, {
        listener: 'webmail-https',
        port: 443,
        tlsMode: 'implicit',
      });
      results.push(wm);
    }

    const sorted = [...results].sort((a, b) => a.port - b.port);
    cache.set(cacheKey, { statuses: sorted, fetchedAt: Date.now() });
    return sorted;
  })();

  inFlight.set(cacheKey, promise);
  promise.finally(() => {
    // Clear AFTER the cache is populated by the resolved promise
    // so subsequent callers hit the cache, not the in-flight map.
    if (inFlight.get(cacheKey) === promise) inFlight.delete(cacheKey);
  });
  return promise;
}

/**
 * Probe a single listener. Returns a status row even on failure so
 * the UI can render the row with `error` populated.
 */
export async function probeListener(
  serviceHost: string,
  serverHostname: string,
  spec: PortSpec,
): Promise<ListenerStatus> {
  const start = Date.now();
  let socket: tls.TLSSocket | null = null;
  try {
    socket = await connectAndUpgrade(serviceHost, serverHostname, spec);
    const status = describeTlsSocket(socket, serverHostname, spec);
    return {
      ...status,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      listener: spec.listener,
      port: spec.port,
      host: serverHostname,
      tlsMode: spec.tlsMode,
      connected: false,
      tlsProtocol: null,
      cipher: null,
      cert: null,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  } finally {
    // Always release the socket — `socket.end()` is a graceful
    // close-notify but doesn't guarantee the underlying TCP is
    // released if describeTlsSocket() throws or the server is
    // unresponsive. `destroy()` is the unconditional teardown.
    socket?.destroy();
  }
}

async function connectAndUpgrade(
  serviceHost: string,
  serverHostname: string,
  spec: PortSpec,
): Promise<tls.TLSSocket> {
  if (spec.tlsMode === 'implicit') {
    return await tlsConnect(serviceHost, spec.port, serverHostname);
  }
  return await starttlsConnect(serviceHost, spec.port, serverHostname, spec.starttlsCommand!);
}

function tlsConnect(host: string, port: number, sni: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host,
        port,
        servername: sni,
        // The probe is purely diagnostic — we want to inspect what
        // Stalwart presents, even if the cert chain doesn't validate
        // against the platform-api pod's CA bundle. The endpoint that
        // calls this service is admin-only; the probe never carries
        // credentials. rejectUnauthorized=false here is OK because
        // we're inspecting, not trusting.
        rejectUnauthorized: false,
        // Bound the handshake — server might be slow / overloaded
        timeout: PROBE_TIMEOUT_MS,
      },
      () => resolve(socket),
    );
    socket.once('error', reject);
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error(`tls timeout after ${PROBE_TIMEOUT_MS}ms`));
    });
  });
}

/**
 * STARTTLS upgrade for SMTP/IMAP/ManageSieve.
 *
 * Wire-protocol abbreviated to the minimum needed to land at TLS:
 *   - SMTP:     EHLO <client>\r\n + STARTTLS\r\n
 *   - IMAP:     A001 STARTTLS\r\n
 *   - SIEVE:    STARTTLS\r\n
 *
 * We don't strictly parse the server's response — once we see ANY
 * data come back AND the response code looks "ok-ish" (250 / OK /
 * +OK), we issue STARTTLS and upgrade. If the server objects, the
 * subsequent TLS handshake will fail and we report the error.
 */
function starttlsConnect(
  host: string,
  port: number,
  sni: string,
  command: 'smtp' | 'imap' | 'managesieve',
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const greetBuf: Buffer[] = [];
    const ehloBuf: Buffer[] = [];
    const replyBuf: Buffer[] = [];
    let timeoutHandle: NodeJS.Timeout | null = null;
    let upgraded = false;

    const fail = (msg: string): void => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      socket.destroy();
      reject(new Error(msg));
    };

    timeoutHandle = setTimeout(
      () => fail(`starttls handshake timeout after ${PROBE_TIMEOUT_MS}ms`),
      PROBE_TIMEOUT_MS,
    );

    socket.on('error', (err) => fail(`tcp error: ${err.message}`));

    // Close-before-upgrade is a hard fail (medium-fix from review):
    // without this, a server that accepts the TCP connection then
    // RSTs before STARTTLS completes would leave the Promise
    // unresolved (the timeout was already cleared on the success
    // paths). Always reject if we lose the socket without having
    // upgraded.
    socket.on('close', () => {
      if (!upgraded) {
        fail('connection closed before STARTTLS upgrade completed');
      }
    });

    socket.once('connect', () => {
      const onGreeting = (chunk: Buffer): void => {
        greetBuf.push(chunk);
        const sofar = Buffer.concat(greetBuf).toString('utf-8');

        // Wait for the protocol-specific greeting.
        if (command === 'smtp' && /^220 /m.test(sofar)) {
          socket.removeListener('data', onGreeting);
          socket.write('EHLO platform-api.mail.svc.cluster.local\r\n');
          socket.on('data', onEhloResponse);
        } else if (command === 'imap' && /^\* OK/m.test(sofar)) {
          socket.removeListener('data', onGreeting);
          socket.write('a001 STARTTLS\r\n');
          socket.on('data', onIssueStarttls);
        } else if (command === 'managesieve' && /^OK\b/m.test(sofar)) {
          // ManageSieve: server may also send capabilities first.
          // The OK can come on the very first line OR after a few
          // capability lines — accumulate until we see the OK token.
          socket.removeListener('data', onGreeting);
          socket.write('STARTTLS\r\n');
          socket.on('data', onIssueStarttls);
        }
      };

      const onEhloResponse = (chunk: Buffer): void => {
        ehloBuf.push(chunk);
        const sofar = Buffer.concat(ehloBuf).toString('utf-8');
        // EHLO response ends with `250 <message>\r\n` (single 250
        // line means the server is done sending capability lines).
        if (/^250 /m.test(sofar)) {
          socket.removeListener('data', onEhloResponse);
          socket.write('STARTTLS\r\n');
          socket.on('data', onIssueStarttls);
        }
      };

      // STARTTLS reply chunk-accumulator (medium-fix from review):
      // SMTP `220 Ready` / IMAP `a001 OK` / ManageSieve `OK` may
      // arrive split across two TCP segments. We accumulate until
      // a complete line ends with CRLF or we see one of the success
      // markers in the joined buffer.
      const onIssueStarttls = (chunk: Buffer): void => {
        replyBuf.push(chunk);
        const reply = Buffer.concat(replyBuf).toString('utf-8');

        // Wait for at least one CRLF — guarantees we've seen a
        // complete line. (For SMTP/IMAP/ManageSieve, the
        // STARTTLS-acknowledgement is exactly one short line.)
        if (!reply.includes('\r\n') && !reply.includes('\n')) return;

        socket.removeListener('data', onIssueStarttls);
        if (/^220 |^a001 OK|^OK\b/m.test(reply)) {
          upgrade();
        } else {
          fail(`starttls negotiation rejected: ${reply.trim().slice(0, 200)}`);
        }
      };

      const upgrade = (): void => {
        const tlsSocket = tls.connect({
          socket,
          servername: sni,
          rejectUnauthorized: false,
          timeout: PROBE_TIMEOUT_MS,
        }, () => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
          }
          upgraded = true;
          resolve(tlsSocket);
        });
        tlsSocket.once('error', (err) => fail(`tls handshake error: ${err.message}`));
      };

      socket.on('data', onGreeting);
    });
  });
}

function describeTlsSocket(
  socket: tls.TLSSocket,
  serverHostname: string,
  spec: PortSpec,
): Omit<ListenerStatus, 'durationMs'> {
  const peerCert = socket.getPeerCertificate(true);
  const cipher = socket.getCipher();
  const tlsProto = socket.getProtocol();

  const cert: CertInfo | null = peerCert && Object.keys(peerCert).length > 0
    ? extractCertInfo(peerCert)
    : null;

  return {
    listener: spec.listener,
    port: spec.port,
    host: serverHostname,
    tlsMode: spec.tlsMode,
    connected: true,
    tlsProtocol: tlsProto ?? null,
    cipher: cipher?.name ?? null,
    cert,
    error: null,
  };
}

function extractCertInfo(peerCert: tls.PeerCertificate): CertInfo {
  const subjectAlternativeNames =
    typeof peerCert.subjectaltname === 'string'
      ? peerCert.subjectaltname
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.startsWith('DNS:'))
          .map((s) => s.slice('DNS:'.length))
      : [];

  const notBefore = new Date(peerCert.valid_from);
  const notAfter = new Date(peerCert.valid_to);
  const daysUntilExpiry = Math.floor((notAfter.getTime() - Date.now()) / (24 * 60 * 60 * 1000));

  const subject = formatDistinguishedName(peerCert.subject as Record<string, unknown> | undefined);
  const issuer = formatDistinguishedName(peerCert.issuer as Record<string, unknown> | undefined);

  return {
    subject,
    issuer,
    subjectAlternativeNames,
    notBefore: notBefore.toISOString(),
    notAfter: notAfter.toISOString(),
    daysUntilExpiry,
    serialNumber: peerCert.serialNumber ?? '',
    fingerprintSha256: peerCert.fingerprint256 ?? '',
  };
}

function formatDistinguishedName(dn: Record<string, unknown> | undefined): string {
  if (!dn) return '';
  // Common DN keys: CN, O, OU, C, L, ST. Render the most operator-
  // useful subset in priority order.
  const parts: string[] = [];
  for (const key of ['CN', 'O', 'OU', 'C']) {
    const v = dn[key];
    if (typeof v === 'string' && v.length > 0) parts.push(`${key}=${v}`);
  }
  return parts.join(', ');
}
