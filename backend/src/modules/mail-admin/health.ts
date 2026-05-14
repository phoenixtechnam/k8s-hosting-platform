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
 * component status block built from real probes. Components ship in
 * waves:
 *
 *   Phase 3a (this file): pod + JMAP. RocksDB / cert / TCP report
 *     `not_implemented`. These are the two probes that cover ~80% of
 *     the actual operational failure modes seen on staging.
 *
 *   Phase 3b: RocksDB-open via stalwart-cli exec, cert validity via
 *     the existing ssl-status cache, and TCP reach with node-mode-
 *     aware target selection.
 *
 * Caching: result is in-process cached for `CACHE_TTL_MS`. The route
 * accepts `?refresh=1` to bypass. Operator UI MUST NOT poll faster
 * than the TTL — relies on `cachedFor` for UI throttling.
 */

import {
  type MailHealthResponse,
  mailHealthResponseSchema,
} from '@k8s-hosting/api-contracts';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const MAIL_NAMESPACE = 'mail';
const STALWART_LABEL = 'app=stalwart-mail';
const STALWART_CONTAINER = 'stalwart';

const CACHE_TTL_MS = 30_000;

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
  readonly clock?: () => number;
  readonly fetcher?: typeof fetch;
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

  const pod = await probePod(deps);
  const jmap = await probeJmap(deps);

  const healthy = pod.healthy && jmap.healthy;
  const response = mailHealthResponseSchema.parse({
    healthy,
    components: {
      pod,
      jmap,
      rocksdb: { healthy: true, status: 'not_implemented', error: null },
      cert: { healthy: true, status: 'not_implemented', error: null },
      tcp: { healthy: true, status: 'not_implemented', error: null },
    },
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
    return {
      durationMs: null,
      serverName: null,
      serverVersion: null,
      healthy: false,
      error: 'Stalwart admin credentials not configured.',
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

function describeInitContainers(initStatuses: RawContainerStatus[]): string | null {
  const stuck = initStatuses.find((c) => !c.ready);
  if (!stuck) return null;
  const waiting = stuck.state?.waiting;
  const terminated = stuck.state?.terminated;
  if (waiting?.reason) return `init:${stuck.name}:${waiting.reason}`;
  if (terminated?.reason) return `init:${stuck.name}:${terminated.reason}`;
  return `init:${stuck.name}:not-ready`;
}
