/**
 * Mail-server health endpoint — actually verifies cluster state.
 *
 * The pre-streamline "Mail Server Status" tile read mailActiveNode +
 * mailPortExposureMode from system_settings and rendered them as a
 * green pill — without ever talking to Stalwart, the pod, or the
 * network. That's why every recent failure mode (RocksDB-lock crash,
 * restore-state hang, NetworkPolicy denying webmail, init-container
 * loop) showed "green" while the cluster was broken.
 *
 * This module exposes `GET /admin/mail/health` and returns a per-
 * component status block built from real probes:
 *
 *   pod      — listNamespacedPod, container ready, restartCount, init
 *              container state. Catches CrashLoopBackOff, ImagePullBackOff,
 *              restore-state initContainer hangs.
 *   jmap     — HTTPS GET /.well-known/jmap with Basic auth. Catches
 *              "pod ready but JMAP unreachable" split-brain shapes.
 *   rocksdb  — kubectl-exec into Stalwart container, checks CURRENT
 *              sentinel + LOCK files exist in /var/lib/stalwart/data.
 *              Both present = RocksDB is open and holding the lock.
 *   cert     — TLS handshake on each implicit-TLS mail port (465 IMPLICIT,
 *              993 IMPLICIT); reads peer cert, computes daysUntilExpiry.
 *   tcp      — Plain TCP connect to each mail port from the platform-api
 *              pod (which is on a different node than Stalwart). Catches
 *              NetworkPolicy denial, hostPort/haproxy misconfiguration.
 *
 * Caching: result is in-process cached for `CACHE_TTL_MS`. The route
 * accepts `?refresh=1` to bypass. Operator UI MUST NOT poll faster
 * than the TTL — relies on `cachedFor` for UI throttling.
 *
 * Probes run in parallel; one failing probe doesn't block the others.
 * Top-level `healthy` is the AND of all components, including the
 * optional ones (Phase 3b made them voting components, not advisory).
 */

import net from 'node:net';
import tls from 'node:tls';
import {
  type MailHealthResponse,
  type MailHealthRocksdbComponent,
  type MailHealthCertComponent,
  type MailHealthCertPort,
  type MailHealthTcpComponent,
  type MailHealthTcpPort,
  mailHealthResponseSchema,
} from '@k8s-hosting/api-contracts';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const MAIL_NAMESPACE = 'mail';
const STALWART_LABEL = 'app=stalwart-mail';
const STALWART_CONTAINER = 'stalwart';
const ROCKSDB_DATA_DIR = '/var/lib/stalwart/data';

const CACHE_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

// In-cluster Service for plain-TCP and TLS probes. This is what the
// platform-api pod can reach without needing the mail-server's public
// IP — and since the pod runs on a different node than Stalwart by
// design, the probe still traverses the network like a real client.
const STALWART_SERVICE_HOST = 'stalwart-mail.mail.svc.cluster.local';

// Mail ports we expect Stalwart to expose. Cert probe only hits the
// implicit-TLS ports (465/993); STARTTLS ports are TCP-only here.
const TCP_PORTS: ReadonlyArray<{ port: number; label: MailHealthTcpPort['port'] }> = [
  { port: 25, label: 25 },
  { port: 465, label: 465 },
  { port: 587, label: 587 },
  { port: 143, label: 143 },
  { port: 993, label: 993 },
  { port: 4190, label: 4190 },
];

const TLS_PORTS: ReadonlyArray<{ port: number; protocol: MailHealthCertPort['protocol'] }> = [
  { port: 465, protocol: 'smtps' },
  { port: 993, protocol: 'imaps' },
];

let cache: { response: MailHealthResponse; expiresAt: number } | null = null;

export interface MailHealthDeps {
  readonly k8s: K8sClients;
  /**
   * Base URL for Stalwart's JMAP endpoint. Defaults to the in-cluster
   * mgmt Service `http://stalwart-mgmt.mail.svc.cluster.local:8080` if
   * `STALWART_MGMT_URL` env is unset. Probe hits `${base}/.well-known/jmap`.
   */
  readonly jmapBaseUrl: string;
  /** Admin user + password for HTTP Basic auth against the JMAP session endpoint. */
  readonly jmapAdminCredentials: { user: string; password: string } | null;
  /**
   * Hostname for TLS SNI on cert probes. If null, cert probe is skipped
   * (returns `not_implemented`). Operator UI gets this from
   * system_settings.mail_server_hostname.
   */
  readonly mailHostname: string | null;
  /** Kubeconfig file path for rocksdb-exec probe; null disables the probe. */
  readonly kubeconfigPath: string | undefined;
  readonly clock?: () => number;
  readonly fetcher?: typeof fetch;
  /** Visible for tests: override the rocksdb exec probe. */
  readonly rocksdbExec?: (podName: string, kubeconfigPath: string | undefined) => Promise<{ currentExists: boolean; lockExists: boolean }>;
  /** Visible for tests: override the TCP probe. */
  readonly tcpProbe?: (host: string, port: number, timeoutMs: number) => Promise<{ reachable: boolean; latencyMs: number | null; error: string | null }>;
  /** Visible for tests: override the TLS probe. */
  readonly tlsProbe?: (host: string, port: number, sni: string, timeoutMs: number) => Promise<{ peerCertificate: tls.PeerCertificate | null; error: string | null }>;
}

export interface GetMailHealthOpts {
  readonly refresh?: boolean;
}

export async function getMailHealth(
  deps: MailHealthDeps,
  opts: GetMailHealthOpts = {},
): Promise<MailHealthResponse> {
  const clock = deps.clock ?? Date.now;
  const now = clock();

  if (!opts.refresh && cache && cache.expiresAt > now) {
    return cache.response;
  }

  // All five probes run in parallel; one failure doesn't block another.
  const [pod, jmap, tcp, cert] = await Promise.all([
    probePod(deps),
    probeJmap(deps),
    probeTcp(deps),
    probeCert(deps),
  ]);
  // RocksDB probe needs the pod name from the pod probe; run sequential.
  const rocksdb = await probeRocksdb(deps, pod.podName);

  const healthy =
    pod.healthy
    && jmap.healthy
    && rocksdb.healthy
    && cert.healthy
    && tcp.healthy;
  const response = mailHealthResponseSchema.parse({
    healthy,
    components: { pod, jmap, rocksdb, cert, tcp },
    checkedAt: new Date(now).toISOString(),
    cachedFor: Math.floor(CACHE_TTL_MS / 1000),
  });

  cache = { response, expiresAt: now + CACHE_TTL_MS };
  return response;
}

/** Visible for tests. Production code must NOT call this. */
export function _resetMailHealthCache(): void {
  cache = null;
}

// ── Probes ────────────────────────────────────────────────────────────────

interface PodProbeShape {
  podName: string | null;
  node: string | null;
  phase: 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Unknown' | null;
  containerReady: boolean | null;
  restartCount: number | null;
  initContainerStatus: string | null;
  healthy: boolean;
  error: string | null;
}

async function probePod(deps: MailHealthDeps): Promise<PodProbeShape> {
  try {
    const pods = await deps.k8s.core.listNamespacedPod({
      namespace: MAIL_NAMESPACE,
      labelSelector: STALWART_LABEL,
    }) as { items?: Array<RawPod> };

    const items = pods.items ?? [];
    const pod = items.find((p) => p.status?.phase === 'Running') ?? items[0];

    if (!pod) {
      return {
        podName: null,
        node: null,
        phase: null,
        containerReady: null,
        restartCount: null,
        initContainerStatus: null,
        healthy: false,
        error: 'No Stalwart pod found in namespace mail (label app=stalwart-mail).',
      };
    }

    const stalwartStatus = (pod.status?.containerStatuses ?? [])
      .find((c) => c.name === STALWART_CONTAINER);
    const initState = describeInitContainers(pod.status?.initContainerStatuses ?? []);
    const phase = normalisePhase(pod.status?.phase);
    const ready = stalwartStatus?.ready ?? null;

    if (!ready) {
      const waiting = stalwartStatus?.state?.waiting;
      const terminated = stalwartStatus?.state?.terminated;
      const reason = waiting?.reason
        ?? terminated?.reason
        ?? initState
        ?? pod.status?.reason
        ?? 'container not ready';
      return {
        podName: pod.metadata?.name ?? null,
        node: pod.spec?.nodeName ?? null,
        phase,
        containerReady: ready,
        restartCount: stalwartStatus?.restartCount ?? null,
        initContainerStatus: initState,
        healthy: false,
        error: `Stalwart pod not ready: ${reason}`,
      };
    }

    return {
      podName: pod.metadata?.name ?? null,
      node: pod.spec?.nodeName ?? null,
      phase,
      containerReady: true,
      restartCount: stalwartStatus?.restartCount ?? null,
      initContainerStatus: initState,
      healthy: true,
      error: null,
    };
  } catch (err) {
    return {
      podName: null,
      node: null,
      phase: null,
      containerReady: null,
      restartCount: null,
      initContainerStatus: null,
      healthy: false,
      error: `Pod probe failed: ${(err as Error).message ?? String(err)}`,
    };
  }
}

interface JmapProbeShape {
  durationMs: number | null;
  serverName: string | null;
  serverVersion: string | null;
  healthy: boolean;
  error: string | null;
}

async function probeJmap(deps: MailHealthDeps): Promise<JmapProbeShape> {
  if (!deps.jmapAdminCredentials) {
    // Skipped probe → healthy: true matches the cert probe pattern
    // (returns healthy when mailHostname missing). Code review caught
    // the asymmetry: a fresh deploy without admin creds wired up
    // would otherwise show globally-unhealthy even when pod + rocksdb
    // + tcp all green. The error string makes the cause visible to
    // an operator looking at the response.
    return {
      durationMs: null,
      serverName: null,
      serverVersion: null,
      healthy: true,
      error: 'Stalwart admin credentials not configured (probe skipped).',
    };
  }

  const fetcher = deps.fetcher ?? globalThis.fetch;
  const auth = Buffer.from(
    `${deps.jmapAdminCredentials.user}:${deps.jmapAdminCredentials.password}`,
  ).toString('base64');
  const sessionUrl = `${deps.jmapBaseUrl.replace(/\/+$/, '')}/.well-known/jmap`;

  const start = (deps.clock ?? Date.now)();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetcher(sessionUrl, {
      method: 'GET',
      headers: { Authorization: `Basic ${auth}` },
      signal: controller.signal,
    });
    const durationMs = (deps.clock ?? Date.now)() - start;

    if (!res.ok) {
      return {
        durationMs,
        serverName: null,
        serverVersion: null,
        healthy: false,
        error: `JMAP session probe HTTP ${res.status}`,
      };
    }
    const body = await res.json() as { capabilities?: Record<string, unknown>; primaryAccounts?: Record<string, string> };
    const serverInfo = body.capabilities?.['urn:ietf:params:jmap:core'] as
      | { coreCapabilities?: Record<string, unknown> }
      | undefined;
    void serverInfo;
    return {
      durationMs,
      serverName: 'Stalwart',
      serverVersion: null, // capabilities don't include version; placeholder until we add x:Server/get
      healthy: true,
      error: null,
    };
  } catch (err) {
    const durationMs = (deps.clock ?? Date.now)() - start;
    return {
      durationMs,
      serverName: null,
      serverVersion: null,
      healthy: false,
      error: `JMAP session probe failed: ${(err as Error).message ?? String(err)}`,
    };
  } finally {
    clearTimeout(t);
  }
}

async function probeRocksdb(
  deps: MailHealthDeps,
  podName: string | null,
): Promise<MailHealthRocksdbComponent> {
  if (!podName) {
    return {
      status: 'fail',
      healthy: false,
      currentFile: null,
      lockFile: null,
      error: 'No Stalwart pod to exec into.',
    };
  }
  const exec = deps.rocksdbExec ?? defaultRocksdbExec;
  try {
    const r = await exec(podName, deps.kubeconfigPath);
    // RocksDB invariants:
    //   CURRENT must exist whenever the DB has been initialised at least once
    //   LOCK    is present only while a process is holding the DB open
    // Both true = healthy. CURRENT missing = data dir empty (catastrophic).
    // LOCK missing while pod is Ready = Stalwart isn't actually using the
    // DataStore (likely crashed silently or misconfigured).
    if (!r.currentExists) {
      return {
        status: 'fail',
        healthy: false,
        currentFile: false,
        lockFile: r.lockExists,
        error: `RocksDB CURRENT sentinel missing at ${ROCKSDB_DATA_DIR}/CURRENT — data dir uninitialised or wrong path.`,
      };
    }
    if (!r.lockExists) {
      return {
        status: 'fail',
        healthy: false,
        currentFile: true,
        lockFile: false,
        error: `RocksDB LOCK file missing — Stalwart isn't holding the DataStore open.`,
      };
    }
    return {
      status: 'ok',
      healthy: true,
      currentFile: true,
      lockFile: true,
      error: null,
    };
  } catch (err) {
    return {
      status: 'fail',
      healthy: false,
      currentFile: null,
      lockFile: null,
      error: `RocksDB exec probe failed: ${(err as Error).message ?? String(err)}`,
    };
  }
}

async function defaultRocksdbExec(
  podName: string,
  kubeconfigPath: string | undefined,
): Promise<{ currentExists: boolean; lockExists: boolean }> {
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
  else kc.loadFromCluster();
  const exec = new k8s.Exec(kc);

  // Run a single sh -c "test ...; echo RESULT" so we get a parseable
  // line even on non-zero exits. test returns 0/1; echo always runs.
  const cmd = [
    'sh', '-c',
    `( test -f ${ROCKSDB_DATA_DIR}/CURRENT && echo "current=1" || echo "current=0" ); `
    + `( test -f ${ROCKSDB_DATA_DIR}/LOCK && echo "lock=1" || echo "lock=0" )`,
  ];

  const { PassThrough, Writable } = await import('node:stream');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stdout = new PassThrough();
    stdout.on('data', (c: Buffer) => chunks.push(c));
    const stderr = new Writable({ write(_c, _e, cb) { cb(); } });
    const timer = setTimeout(() => reject(new Error('rocksdb probe timed out')), PROBE_TIMEOUT_MS);
    exec.exec(
      MAIL_NAMESPACE, podName, STALWART_CONTAINER, cmd,
      stdout, stderr, null, false,
      (status) => {
        clearTimeout(timer);
        const out = Buffer.concat(chunks).toString('utf8');
        if (status.status === 'Failure') {
          reject(new Error(status.message ?? 'rocksdb probe non-zero exit'));
          return;
        }
        resolve({
          currentExists: /current=1/.test(out),
          lockExists: /lock=1/.test(out),
        });
      },
    ).catch(reject);
  });
}

async function probeTcp(deps: MailHealthDeps): Promise<MailHealthTcpComponent> {
  const probe = deps.tcpProbe ?? defaultTcpProbe;
  const results: MailHealthTcpPort[] = await Promise.all(
    TCP_PORTS.map(async ({ port }) => {
      const r = await probe(STALWART_SERVICE_HOST, port, PROBE_TIMEOUT_MS);
      return { port, reachable: r.reachable, latencyMs: r.latencyMs, error: r.error };
    }),
  );
  const unreachable = results.filter((r) => !r.reachable);
  if (unreachable.length === 0) {
    return { status: 'ok', healthy: true, ports: results, error: null };
  }
  return {
    status: 'fail',
    healthy: false,
    ports: results,
    error: `${unreachable.length}/${results.length} mail ports unreachable: ${unreachable.map((u) => u.port).join(', ')}`,
  };
}

function defaultTcpProbe(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ reachable: boolean; latencyMs: number | null; error: string | null }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = net.createConnection({ host, port });
    let settled = false;
    const cleanup = (out: { reachable: boolean; latencyMs: number | null; error: string | null }) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(out);
    };
    sock.setTimeout(timeoutMs, () => cleanup({
      reachable: false,
      latencyMs: null,
      error: `connect timed out after ${timeoutMs}ms`,
    }));
    sock.on('connect', () => cleanup({
      reachable: true,
      latencyMs: Date.now() - start,
      error: null,
    }));
    sock.on('error', (err) => cleanup({
      reachable: false,
      latencyMs: null,
      error: (err as Error).message ?? String(err),
    }));
  });
}

async function probeCert(deps: MailHealthDeps): Promise<MailHealthCertComponent> {
  if (!deps.mailHostname) {
    return {
      status: 'not_implemented',
      healthy: true,
      ports: [],
      error: null,
    };
  }
  const probe = deps.tlsProbe ?? defaultTlsProbe;
  const results: MailHealthCertPort[] = await Promise.all(
    TLS_PORTS.map(async ({ port, protocol }) => {
      const r = await probe(STALWART_SERVICE_HOST, port, deps.mailHostname!, PROBE_TIMEOUT_MS);
      if (r.error || !r.peerCertificate) {
        return {
          port,
          protocol,
          daysUntilExpiry: null,
          issuer: null,
          error: r.error ?? 'no peer certificate',
        };
      }
      const cert = r.peerCertificate;
      const notAfter = cert.valid_to ? new Date(cert.valid_to) : null;
      const daysUntilExpiry = notAfter
        ? Math.floor((notAfter.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
        : null;
      // tls.PeerCertificate.issuer.CN/.O can be string | string[] when
      // the subject has multiple components. Coerce to a single string
      // for the response (multi-component issuers are rare in practice).
      const issuer = cert.issuer
        ? firstString(cert.issuer.CN) ?? firstString(cert.issuer.O) ?? null
        : null;
      return { port, protocol, daysUntilExpiry, issuer, error: null };
    }),
  );

  const errored = results.filter((r) => r.error !== null);
  const expiringSoon = results.filter((r) => r.daysUntilExpiry !== null && r.daysUntilExpiry < 7);
  if (errored.length > 0) {
    return {
      status: 'fail',
      healthy: false,
      ports: results,
      error: `${errored.length}/${results.length} cert probes failed: ${errored.map((e) => `${e.port}:${e.error}`).join('; ')}`,
    };
  }
  if (expiringSoon.length > 0) {
    return {
      status: 'fail',
      healthy: false,
      ports: results,
      error: `Cert expiring on ports: ${expiringSoon.map((p) => `${p.port} (${p.daysUntilExpiry}d)`).join(', ')}`,
    };
  }
  return { status: 'ok', healthy: true, ports: results, error: null };
}

function defaultTlsProbe(
  host: string,
  port: number,
  sni: string,
  timeoutMs: number,
): Promise<{ peerCertificate: tls.PeerCertificate | null; error: string | null }> {
  return new Promise((resolve) => {
    const sock = tls.connect({
      host,
      port,
      servername: sni,
      // We're probing certs, not authenticating — the cert may be valid
      // for `sni` but the in-cluster Service IP isn't in any SAN. Don't
      // fail handshake on that. We still read the cert.
      rejectUnauthorized: false,
      timeout: timeoutMs,
    });
    let settled = false;
    const cleanup = (out: { peerCertificate: tls.PeerCertificate | null; error: string | null }) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(out);
    };
    sock.on('secureConnect', () => {
      const cert = sock.getPeerCertificate();
      cleanup({
        peerCertificate: cert && Object.keys(cert).length > 0 ? cert : null,
        error: null,
      });
    });
    sock.on('timeout', () => cleanup({ peerCertificate: null, error: `TLS handshake timed out after ${timeoutMs}ms` }));
    sock.on('error', (err) => cleanup({ peerCertificate: null, error: (err as Error).message ?? String(err) }));
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────

interface RawContainerStatus {
  name?: string;
  ready?: boolean;
  restartCount?: number;
  state?: {
    waiting?: { reason?: string; message?: string };
    terminated?: { reason?: string; message?: string };
  };
}

interface RawPod {
  metadata?: { name?: string };
  spec?: { nodeName?: string };
  status?: {
    phase?: string;
    reason?: string;
    containerStatuses?: RawContainerStatus[];
    initContainerStatuses?: RawContainerStatus[];
  };
}

function normalisePhase(phase: string | undefined): PodProbeShape['phase'] {
  switch (phase) {
    case 'Pending':
    case 'Running':
    case 'Succeeded':
    case 'Failed':
    case 'Unknown':
      return phase;
    default:
      return null;
  }
}

function firstString(v: string | string[] | undefined): string | null {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length > 0) return v[0];
  return null;
}

function describeInitContainers(initStatuses: RawContainerStatus[]): string | null {
  const stuck = initStatuses.find((c) => !c.ready);
  if (!stuck) return null;
  const waiting = stuck.state?.waiting;
  const terminated = stuck.state?.terminated;
  if (waiting?.reason) return `init:${stuck.name}:${waiting.reason}`;
  if (terminated?.reason) return `init:${stuck.name}:${terminated.reason}`;
  return `init:${stuck.name}:not-ready`;
}
