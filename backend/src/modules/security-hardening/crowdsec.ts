/**
 * CrowdSec — Banned IPs admin service.
 *
 * Wraps the in-cluster CrowdSec Local API (LAPI). Reads use the
 * bouncer key (HTTP); writes (manual ban / unban) shell out to `cscli`
 * inside the CrowdSec pod via `kubectl exec` because the LAPI
 * machine-auth path is not exposed to the platform.
 *
 * Manual bans added by this UI are prefixed with `MANUAL_BAN_REASON_PREFIX`
 * in the scenario field so the list endpoint can flag them as
 * operator-added vs automatic (community blocklist / scenario hits).
 *
 * Cluster-wide enforcement coverage is provided by the Traefik
 * DaemonSet — every node's Traefik replica queries the same LAPI on
 * every request via the crowdsec middleware. We surface the
 * traefik-pods-vs-nodes count in the status response so an operator
 * can see at a glance whether enforcement is universal.
 */

import * as k8s from '@kubernetes/client-node';
import { PassThrough } from 'node:stream';
import { Buffer } from 'node:buffer';
import { createKubeConfig } from '../container-console/service.js';
import type {
  CrowdsecAddBanRequest,
  CrowdsecBouncer,
  CrowdsecCoverage,
  CrowdsecDecision,
  CrowdsecListDecisionsQuery,
  CrowdsecListDecisionsResponse,
  CrowdsecMachine,
  CrowdsecStatus,
} from '@k8s-hosting/api-contracts';

const CROWDSEC_NAMESPACE = 'crowdsec';
const CROWDSEC_DEPLOYMENT = 'crowdsec';
const CROWDSEC_CONTAINER = 'crowdsec';
const CROWDSEC_BOUNCER_SECRET = 'crowdsec-bouncer-key';
const CROWDSEC_BOUNCER_SECRET_KEY = 'bouncer-key';
const LAPI_BASE_URL = process.env.CROWDSEC_LAPI_URL ?? 'http://crowdsec.crowdsec.svc.cluster.local:8080';
const TRAEFIK_NAMESPACE = 'traefik';
const TRAEFIK_DAEMONSET = 'traefik';
const MODSEC_LABEL_SELECTOR = 'app.kubernetes.io/name=modsec-crs';

/**
 * All bans added through this UI carry this prefix in the scenario/reason
 * field. Used to distinguish operator-added bans from automatic ones
 * (community blocklist, scenario triggers) on the listing screen.
 */
export const MANUAL_BAN_REASON_PREFIX = 'admin-panel:';

const CSCLI_EXEC_TIMEOUT_MS = 15_000;
const LAPI_HTTP_TIMEOUT_MS = 8_000;

// ─── KubeConfig loading + bouncer key caching ──────────────────────────

// Module-level cache — single-process Fastify deployment today. If the
// platform scales to multiple platform-api replicas, each replica holds
// its own copy; on Secret rotation, every replica picks up the new key
// within BOUNCER_KEY_TTL_MS independently. Move to Redis if cross-replica
// invalidation matters (the platform already uses Redis for other TTL
// caches).
let cachedBouncerKey: { value: string; loadedAt: number } | null = null;
const BOUNCER_KEY_TTL_MS = 5 * 60 * 1000;

async function loadBouncerKey(kc: k8s.KubeConfig): Promise<string> {
  if (cachedBouncerKey && Date.now() - cachedBouncerKey.loadedAt < BOUNCER_KEY_TTL_MS) {
    return cachedBouncerKey.value;
  }
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const secret = await core.readNamespacedSecret({
    name: CROWDSEC_BOUNCER_SECRET,
    namespace: CROWDSEC_NAMESPACE,
  });
  const data = (secret as unknown as { data?: Record<string, string> }).data ?? {};
  const b64 = data[CROWDSEC_BOUNCER_SECRET_KEY];
  if (!b64) {
    throw new Error(`Secret ${CROWDSEC_NAMESPACE}/${CROWDSEC_BOUNCER_SECRET} missing key "${CROWDSEC_BOUNCER_SECRET_KEY}"`);
  }
  const decoded = Buffer.from(b64, 'base64').toString('utf-8').trim();
  cachedBouncerKey = { value: decoded, loadedAt: Date.now() };
  return decoded;
}

// ─── LAPI HTTP helpers ─────────────────────────────────────────────────

interface LapiRawDecision {
  id?: number;
  origin?: string;
  type?: string;
  scope?: string;
  value?: string;
  scenario?: string;
  duration?: string;
  simulated?: boolean;
}

async function lapiGet<T>(path: string, key: string): Promise<T> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), LAPI_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${LAPI_BASE_URL}${path}`, {
      headers: { 'X-Api-Key': key, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`LAPI GET ${path} → HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function lapiHealth(): Promise<{ healthy: boolean; error: string | null }> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), LAPI_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${LAPI_BASE_URL}/health`, { signal: ctrl.signal });
    return { healthy: res.ok, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    return { healthy: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

// ─── cscli exec helper ────────────────────────────────────────────────

async function findCrowdsecPodName(kc: k8s.KubeConfig): Promise<string> {
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const pods = await (core as unknown as {
    listNamespacedPod: (args: { namespace: string; labelSelector: string }) => Promise<{
      items: { metadata?: { name?: string }; status?: { phase?: string } }[];
    }>;
  }).listNamespacedPod({
    namespace: CROWDSEC_NAMESPACE,
    labelSelector: 'app.kubernetes.io/name=crowdsec',
  });
  const running = (pods.items ?? []).find((p) => p.status?.phase === 'Running' && p.metadata?.name);
  if (!running?.metadata?.name) {
    throw new Error(`No Running pod found for app.kubernetes.io/name=crowdsec in ${CROWDSEC_NAMESPACE}`);
  }
  return running.metadata.name;
}

/**
 * Run a cscli command inside the CrowdSec pod, collect stdout/stderr.
 * Times out after CSCLI_EXEC_TIMEOUT_MS so a hung exec can't block the
 * Fastify worker.
 */
async function cscliExec(
  kc: k8s.KubeConfig,
  podName: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const exec = new k8s.Exec(kc);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
  stderr.on('data', (c: Buffer) => stderrChunks.push(c));

  // Race-safe: a `done` flag prevents double-resolve, and the timeout
  // closes the WebSocket via a holder that's populated below — if the
  // timer fires BEFORE exec.exec()'s Promise resolves the holder is
  // still empty, so we mark `done` and let the eventual resolved
  // connection close itself in the .then() (which checks `done`).
  let done = false;
  let timer: NodeJS.Timeout | null = null;
  const wsHolder: { conn: { close?: () => void } | null } = { conn: null };
  const finish = (err: Error | null, value?: { stdout: string; stderr: string }) => {
    if (done) return;
    done = true;
    if (timer) { clearTimeout(timer); timer = null; }
    try { wsHolder.conn?.close?.(); } catch { /* swallow */ }
    if (err) deferredReject(err); else deferredResolve(value as { stdout: string; stderr: string });
  };

  let deferredResolve!: (v: { stdout: string; stderr: string }) => void;
  let deferredReject!: (e: Error) => void;
  const result = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    deferredResolve = resolve;
    deferredReject = reject;
  });

  timer = setTimeout(() => {
    finish(new Error(`cscli exec timed out after ${CSCLI_EXEC_TIMEOUT_MS}ms`));
  }, CSCLI_EXEC_TIMEOUT_MS);

  exec.exec(
    CROWDSEC_NAMESPACE,
    podName,
    CROWDSEC_CONTAINER,
    ['cscli', ...args],
    stdout,
    stderr,
    null,
    false,
    (status) => {
      const so = Buffer.concat(stdoutChunks).toString('utf-8');
      const se = Buffer.concat(stderrChunks).toString('utf-8');
      if (status.status === 'Success') {
        finish(null, { stdout: so, stderr: se });
      } else {
        finish(new Error(`cscli ${args.join(' ')} failed: ${status.message ?? status.status} stderr=${se}`));
      }
    },
  ).then((conn) => {
    const handle = conn as unknown as { close?: () => void };
    if (done) {
      // The timer already fired — close the connection that we couldn't
      // close from the timer because it hadn't been returned yet.
      try { handle.close?.(); } catch { /* swallow */ }
      return;
    }
    wsHolder.conn = handle;
  }).catch((err) => {
    finish(err instanceof Error ? err : new Error(String(err)));
  });

  return result;
}

// ─── Decision shape mapping ───────────────────────────────────────────

function parseLapiDecision(d: LapiRawDecision): CrowdsecDecision | null {
  const idNum = typeof d.id === 'number' ? d.id : Number(d.id);
  const origin = String(d.origin ?? '');
  const type = String(d.type ?? '');
  const scope = String(d.scope ?? '');
  const value = String(d.value ?? '');
  const scenario = String(d.scenario ?? '');
  const duration = String(d.duration ?? '');
  if (!Number.isFinite(idNum) || !value) return null;
  // Validate enums — drop unknown values rather than throw.
  if (type !== 'ban' && type !== 'captcha' && type !== 'throttle' && type !== 'mfa') return null;
  if (scope !== 'Ip' && scope !== 'Range' && scope !== 'Country' && scope !== 'AS') return null;
  return {
    id: idNum,
    origin,
    type,
    scope,
    value,
    scenario,
    duration,
    expiresAt: parseDurationToAbsolute(duration),
    manualByOperator: origin === 'cscli' && scenario.startsWith(MANUAL_BAN_REASON_PREFIX),
    simulated: Boolean(d.simulated),
  };
}

/**
 * Best-effort: CrowdSec durations come as "4h3m12s" / "29d" / "1m". Map
 * to an absolute ISO timestamp relative to "now" so the UI can render
 * "expires in 4h" / sort by expiry. Returns null for unparseable inputs.
 */
function parseDurationToAbsolute(duration: string): string | null {
  const re = /(-?)(\d+)([smhd])/g;
  let totalMs = 0;
  let sign = 1;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(duration)) !== null) {
    matched = true;
    if (m[1] === '-') sign = -1;
    const n = Number(m[2]);
    const unit = m[3];
    const mult = unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    totalMs += n * mult;
  }
  if (!matched) return null;
  return new Date(Date.now() + sign * totalMs).toISOString();
}

// ─── Public service surface ────────────────────────────────────────────

export async function listDecisions(
  kubeconfigPath: string | undefined,
  query: CrowdsecListDecisionsQuery,
): Promise<CrowdsecListDecisionsResponse> {
  const kc = createKubeConfig(kubeconfigPath);
  const key = await loadBouncerKey(kc);
  const raw = await lapiGet<LapiRawDecision[] | null>('/v1/decisions', key);
  const all = (raw ?? []).map(parseLapiDecision).filter((d): d is CrowdsecDecision => d !== null);
  let filtered = all;
  if (query.scope) filtered = filtered.filter((d) => d.scope === query.scope);
  if (query.manualOnly) filtered = filtered.filter((d) => d.manualByOperator);
  if (query.q) {
    const q = query.q.toLowerCase();
    filtered = filtered.filter((d) => d.value.toLowerCase().includes(q));
  }
  return {
    decisions: filtered,
    totalActive: all.length,
  };
}

export async function addBan(
  kubeconfigPath: string | undefined,
  req: CrowdsecAddBanRequest,
  actor: string,
): Promise<{ message: string }> {
  const kc = createKubeConfig(kubeconfigPath);
  const podName = await findCrowdsecPodName(kc);
  // Scenario field carries the prefix + actor + reason so the listing endpoint can
  // surface "added by <actor>: <reason>" and the manualByOperator flag is reliable.
  const scenario = `${MANUAL_BAN_REASON_PREFIX}${actor}:${req.reason}`;
  // cscli uses --ip for single IPs and --range for CIDRs. Build the list
  // declaratively so reordering arguments above doesn't silently break the
  // flag swap (the previous `cscliArgs[3] = '--range'` form was fragile).
  const targetFlag = req.scope === 'Range' ? '--range' : '--ip';
  const cscliArgs = [
    'decisions', 'add',
    targetFlag, req.value,
    '--duration', req.duration,
    '--reason', scenario,
    '--type', 'ban',
  ];
  const { stdout, stderr } = await cscliExec(kc, podName, cscliArgs);
  return { message: (stdout + stderr).trim().slice(0, 500) };
}

export async function deleteDecisionById(
  kubeconfigPath: string | undefined,
  id: number,
): Promise<{ message: string; deleted: number }> {
  if (!Number.isInteger(id) || id < 0) {
    throw new Error('invalid decision id');
  }
  const kc = createKubeConfig(kubeconfigPath);
  const podName = await findCrowdsecPodName(kc);
  const { stdout, stderr } = await cscliExec(kc, podName, ['decisions', 'delete', '--id', String(id)]);
  const combined = (stdout + stderr).trim();
  // cscli prints "N decision(s) deleted" — extract the count for the UI.
  const match = combined.match(/(\d+)\s+decision\(s\)\s+deleted/);
  const deleted = match ? Number(match[1]) : 0;
  return { message: combined.slice(0, 500), deleted };
}

// ─── Status / coverage ─────────────────────────────────────────────────

interface CscliMachineRow { name?: string; ipAddress?: string; lastHeartbeat?: string; status?: string }
interface CscliBouncerRow { name?: string; ip?: string; ip_address?: string; type?: string; lastPull?: string; revoked?: boolean }

async function fetchMachinesAndBouncers(kc: k8s.KubeConfig, podName: string): Promise<{
  machines: CrowdsecMachine[]; bouncers: CrowdsecBouncer[];
}> {
  const [machinesRes, bouncersRes] = await Promise.allSettled([
    cscliExec(kc, podName, ['machines', 'list', '-o', 'json']),
    cscliExec(kc, podName, ['bouncers', 'list', '-o', 'json']),
  ]);
  const machines: CrowdsecMachine[] = [];
  const bouncers: CrowdsecBouncer[] = [];
  if (machinesRes.status === 'fulfilled') {
    try {
      const parsed = JSON.parse(machinesRes.value.stdout) as CscliMachineRow[];
      for (const m of parsed) {
        machines.push({
          name: String(m.name ?? ''),
          ipAddress: String(m.ipAddress ?? ''),
          lastHeartbeatAt: m.lastHeartbeat ?? null,
          online: typeof m.lastHeartbeat === 'string' && (Date.now() - new Date(m.lastHeartbeat).getTime()) < 5 * 60_000,
        });
      }
    } catch { /* swallow — machines list is best-effort */ }
  }
  if (bouncersRes.status === 'fulfilled') {
    try {
      const parsed = JSON.parse(bouncersRes.value.stdout) as CscliBouncerRow[];
      for (const b of parsed) {
        const lastPull = b.lastPull;
        bouncers.push({
          name: String(b.name ?? ''),
          ipAddress: String(b.ip ?? b.ip_address ?? ''),
          type: String(b.type ?? ''),
          lastApiPullAt: lastPull ?? null,
          online: typeof lastPull === 'string' && (Date.now() - new Date(lastPull).getTime()) < 5 * 60_000,
        });
      }
    } catch { /* swallow */ }
  }
  return { machines, bouncers };
}

async function fetchCapiStatus(kc: k8s.KubeConfig, podName: string): Promise<{ authenticated: boolean; pullEnabled: boolean }> {
  try {
    const { stdout } = await cscliExec(kc, podName, ['capi', 'status']);
    return {
      authenticated: /successfully interact with Central API/i.test(stdout),
      pullEnabled: /Pulling community blocklist is enabled/i.test(stdout),
    };
  } catch {
    return { authenticated: false, pullEnabled: false };
  }
}

async function fetchScenariosCount(kc: k8s.KubeConfig, podName: string): Promise<number> {
  try {
    const { stdout } = await cscliExec(kc, podName, ['scenarios', 'list', '-o', 'json']);
    const parsed = JSON.parse(stdout) as Record<string, unknown[]> | unknown[];
    if (Array.isArray(parsed)) return parsed.length;
    // cscli sometimes wraps in { scenarios: [...] }
    const scen = (parsed as { scenarios?: unknown[] }).scenarios;
    return Array.isArray(scen) ? scen.length : 0;
  } catch {
    return 0;
  }
}

async function fetchCoverage(kc: k8s.KubeConfig): Promise<CrowdsecCoverage> {
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const apps = kc.makeApiClient(k8s.AppsV1Api);
  let traefikPodsTotal = 0;
  let traefikPodsCovered = 0;
  let modsecPodsTotal = 0;
  let nodesTotal = 0;
  try {
    const ds = await (apps as unknown as {
      readNamespacedDaemonSet: (args: { namespace: string; name: string }) => Promise<{
        status?: { numberAvailable?: number; numberReady?: number; desiredNumberScheduled?: number };
      }>;
    }).readNamespacedDaemonSet({ namespace: TRAEFIK_NAMESPACE, name: TRAEFIK_DAEMONSET });
    traefikPodsTotal = Number(ds.status?.desiredNumberScheduled ?? 0);
    // "Covered" = ready (every ready Traefik pod has the crowdsec middleware
    // loaded via the cluster-wide Middleware resource — see
    // k8s/base/traefik/middlewares-crowdsec.yaml).
    traefikPodsCovered = Number(ds.status?.numberReady ?? 0);
  } catch { /* swallow — return zeros */ }
  try {
    const modsecPods = await (core as unknown as {
      listNamespacedPod: (args: { namespace: string; labelSelector: string }) => Promise<{
        items: { status?: { phase?: string } }[];
      }>;
    }).listNamespacedPod({ namespace: TRAEFIK_NAMESPACE, labelSelector: MODSEC_LABEL_SELECTOR });
    modsecPodsTotal = (modsecPods.items ?? []).filter((p) => p.status?.phase === 'Running').length;
  } catch { /* swallow */ }
  try {
    const nodes = await (core as unknown as {
      listNode: () => Promise<{ items: { status?: { conditions?: { type?: string; status?: string }[] } }[] }>;
    }).listNode();
    nodesTotal = (nodes.items ?? []).filter((n) =>
      n.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'),
    ).length;
  } catch { /* swallow */ }
  return { traefikPodsTotal, traefikPodsCovered, modsecPodsTotal, nodesTotal };
}

export async function getStatus(kubeconfigPath: string | undefined): Promise<CrowdsecStatus> {
  const kc = createKubeConfig(kubeconfigPath);
  // Fail soft per component — a single cscli error shouldn't blank the
  // whole status banner.
  const health = await lapiHealth();
  let podName: string | null = null;
  try { podName = await findCrowdsecPodName(kc); } catch { /* leave null */ }

  const [coverage, capi, machinesBouncers, scenariosLoaded] = await Promise.all([
    fetchCoverage(kc),
    podName ? fetchCapiStatus(kc, podName) : Promise.resolve({ authenticated: false, pullEnabled: false }),
    podName ? fetchMachinesAndBouncers(kc, podName) : Promise.resolve({ machines: [], bouncers: [] }),
    podName ? fetchScenariosCount(kc, podName) : Promise.resolve(0),
  ]);

  return {
    lapiHealthy: health.healthy,
    lapiError: health.error,
    capiAuthenticated: capi.authenticated,
    communityBlocklistEnabled: capi.pullEnabled,
    machines: machinesBouncers.machines,
    bouncers: machinesBouncers.bouncers,
    scenariosLoaded,
    coverage,
  };
}

// ─── Test seams (exported for unit tests) ──────────────────────────────

export const __test = {
  parseLapiDecision,
  parseDurationToAbsolute,
  MANUAL_BAN_REASON_PREFIX,
};
