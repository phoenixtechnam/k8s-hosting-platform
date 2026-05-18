/**
 * Reads per-node ConfigMaps published by the security-probe DaemonSet
 * and normalises them into the {@link NodeSecuritySnapshot} contract.
 *
 * The probe ConfigMap shape (matches images/security-probe/types.go):
 *
 *   metadata.name: security-probe-<nodeName>
 *   metadata.namespace: platform-system
 *   metadata.labels:
 *     app: security-probe
 *     security-probe.platform/node: <nodeName>
 *   data.snapshot: <json>
 *
 * The JSON shape is duck-typed at runtime — if the probe is on a
 * different version than the backend, missing fields fall through
 * as null/empty defaults rather than throwing. The schema contract is
 * the single source of truth (api-contracts) but the probe MAY add
 * fields ahead of the backend recognising them.
 */

import type { CoreV1Api } from '@kubernetes/client-node';
import {
  type NodeSecuritySnapshot,
  type NodeMeshStatus,
  type NodeSshExposure,
  type NodeHardening,
  type PublicPortsPerNode,
  type CisFinding,
  type SshdFlags,
  type MeshProvider,
  type SshRestrictionMode,
  type CisSeverity,
  type DeniedCountWindow,
} from '@k8s-hosting/api-contracts';
import {
  PROBE_NAMESPACE,
  PROBE_CONFIGMAP_PREFIX,
  PROBE_STALE_AFTER_MS,
} from './k8s-client.js';

/** Wire format from the probe — kept private; outside callers receive
 *  the contract types. */
interface ProbeSnapshotWire {
  readonly nodeName?: string;
  readonly generatedAt?: string;
  readonly mesh?: {
    readonly provider?: string;
    readonly interfaceName?: string | null;
    readonly interfaceIp?: string | null;
    readonly peerCount?: number | null;
    readonly lastHandshakeAgeSeconds?: number | null;
  };
  readonly ssh?: {
    readonly restrictionMode?: string;
    readonly sshViaMeshFlag?: boolean;
    readonly enforcedInterface?: string | null;
    readonly sshdFlags?: {
      readonly permitRootLogin?: string | null;
      readonly passwordAuthentication?: string | null;
      readonly kbdInteractiveAuthentication?: string | null;
      readonly allowUsers?: ReadonlyArray<string>;
      readonly port?: number;
      readonly configSha256?: string;
    };
    readonly parseSucceeded?: boolean;
    readonly parseError?: string | null;
  };
  readonly hardening?: {
    readonly kernelVersion?: string;
    readonly kernelEol?: boolean;
    readonly timeSinceRebootSeconds?: number;
    readonly pendingKernelUpdate?: boolean;
    readonly fail2banPresent?: boolean;
    readonly sshguardPresent?: boolean;
    readonly unattendedUpgradesActive?: boolean;
    readonly automaticRebootWindow?: string | null;
    readonly osPretty?: string;
    readonly cisFindings?: ReadonlyArray<{
      readonly id?: string;
      readonly severity?: string;
      readonly title?: string;
      readonly observed?: string;
      readonly expected?: string;
      readonly passing?: boolean;
    }>;
  };
  readonly publicPortsV4?: { readonly tcp?: ReadonlyArray<number>; readonly udp?: ReadonlyArray<number> };
  readonly conntrack?: {
    readonly available?: boolean;
    readonly denies?: number | null;
    readonly windowSeconds?: number;
    readonly reason?: string | null;
  };
}

/** Listing result split into snapshots + the per-node firewall ports
 *  + per-node conntrack samples (best-effort denied-flow counter). */
export interface ProbeReadResult {
  readonly snapshots: ReadonlyArray<NodeSecuritySnapshot>;
  readonly publicPortsPerNode: ReadonlyArray<PublicPortsPerNode>;
  readonly conntrackByNode: ReadonlyArray<{ readonly nodeName: string; readonly window: DeniedCountWindow }>;
}

/** Fetch every probe ConfigMap in platform-system and decode it.
 *  Missing/corrupt ConfigMaps are skipped (logged by the caller). */
export async function readProbeSnapshots(
  core: CoreV1Api,
  now: () => Date = () => new Date(),
): Promise<ProbeReadResult> {
  const list = await core.listNamespacedConfigMap({
    namespace: PROBE_NAMESPACE,
    labelSelector: 'app=security-probe',
  });
  const items = list.items ?? [];
  const snapshots: NodeSecuritySnapshot[] = [];
  const publicPortsPerNode: PublicPortsPerNode[] = [];
  const conntrackByNode: { nodeName: string; window: DeniedCountWindow }[] = [];
  for (const cm of items) {
    const name = cm.metadata?.name ?? '';
    if (!name.startsWith(PROBE_CONFIGMAP_PREFIX)) continue;
    const nodeName = name.slice(PROBE_CONFIGMAP_PREFIX.length);
    const raw = cm.data?.snapshot;
    if (!raw) continue;
    let parsed: ProbeSnapshotWire;
    try {
      parsed = JSON.parse(raw) as ProbeSnapshotWire;
    } catch {
      continue;
    }
    const lastUpdatedAt = resolveLastUpdatedAt(cm.metadata);
    const snap = decodeSnapshot(nodeName, parsed, lastUpdatedAt, now());
    snapshots.push(snap);
    publicPortsPerNode.push({
      nodeName,
      tcp: [...(parsed.publicPortsV4?.tcp ?? [])],
      udp: [...(parsed.publicPortsV4?.udp ?? [])],
    });
    conntrackByNode.push({
      nodeName,
      window: {
        available: Boolean(parsed.conntrack?.available),
        denies: typeof parsed.conntrack?.denies === 'number' ? parsed.conntrack.denies : null,
        windowSeconds:
          typeof parsed.conntrack?.windowSeconds === 'number' ? parsed.conntrack.windowSeconds : 60,
        reason: parsed.conntrack?.reason ?? null,
      },
    });
  }
  return { snapshots, publicPortsPerNode, conntrackByNode };
}

/** Aggregate per-node conntrack samples into a single cluster-wide
 *  denied-count window. Sums denies across nodes; falls back to
 *  unavailable if every node reports unavailable. */
export function aggregateConntrack(
  perNode: ReadonlyArray<{ readonly nodeName: string; readonly window: DeniedCountWindow }>,
): DeniedCountWindow {
  if (perNode.length === 0) {
    return {
      available: false,
      denies: null,
      windowSeconds: 60,
      reason: 'no probe reports yet',
    };
  }
  const available = perNode.filter((n) => n.window.available);
  if (available.length === 0) {
    return {
      available: false,
      denies: null,
      windowSeconds: perNode[0].window.windowSeconds,
      reason: perNode[0].window.reason ?? 'conntrack unavailable on all nodes',
    };
  }
  const totalDenies = available.reduce((sum, n) => sum + (n.window.denies ?? 0), 0);
  return {
    available: true,
    denies: totalDenies,
    windowSeconds: available[0].window.windowSeconds,
    reason: available.length < perNode.length
      ? `${perNode.length - available.length} node(s) unavailable`
      : null,
  };
}

/** Resolve the most recent write time for a probe ConfigMap. Prefers
 *  the latest managedFields entry (set by every Update), falls back
 *  to creationTimestamp. Either source may be a Date object (from
 *  the typed client) or an ISO string (from raw payloads); both are
 *  handled. */
function resolveLastUpdatedAt(metadata: { managedFields?: ReadonlyArray<{ time?: Date | string }>; creationTimestamp?: Date | string } | undefined): string | null {
  if (!metadata) return null;
  const mfTime = metadata.managedFields?.[metadata.managedFields.length - 1]?.time;
  if (mfTime instanceof Date) return mfTime.toISOString();
  if (typeof mfTime === 'string' && mfTime) return mfTime;
  const ct = metadata.creationTimestamp;
  if (ct instanceof Date) return ct.toISOString();
  if (typeof ct === 'string' && ct) return ct;
  return null;
}

const ALLOWED_PROVIDERS: ReadonlySet<MeshProvider> = new Set(['netbird', 'tailscale', 'wireguard', 'none']);
const ALLOWED_MODES: ReadonlySet<SshRestrictionMode> = new Set([
  'public',
  'mesh-only',
  'trusted-only',
  'mesh-and-trusted',
]);
const ALLOWED_SEVERITIES: ReadonlySet<CisSeverity> = new Set(['critical', 'high', 'medium', 'low', 'info']);

/** Convert the probe's wire shape into the api-contracts shape.
 *  Defensive about field presence so probe-version drift never throws. */
export function decodeSnapshot(
  nodeName: string,
  raw: ProbeSnapshotWire,
  lastUpdatedAt: string | null,
  now: Date,
): NodeSecuritySnapshot {
  const meshProvider = ALLOWED_PROVIDERS.has(raw.mesh?.provider as MeshProvider)
    ? (raw.mesh?.provider as MeshProvider)
    : 'none';
  const mesh: NodeMeshStatus = {
    nodeName,
    provider: meshProvider,
    interfaceName: raw.mesh?.interfaceName ?? null,
    interfaceIp: raw.mesh?.interfaceIp ?? null,
    peerCount: typeof raw.mesh?.peerCount === 'number' ? raw.mesh.peerCount : null,
    lastHandshakeAgeSeconds:
      typeof raw.mesh?.lastHandshakeAgeSeconds === 'number' ? raw.mesh.lastHandshakeAgeSeconds : null,
  };

  const restrictionMode = ALLOWED_MODES.has(raw.ssh?.restrictionMode as SshRestrictionMode)
    ? (raw.ssh?.restrictionMode as SshRestrictionMode)
    : 'public';
  const sshdFlags: SshdFlags = {
    permitRootLogin: raw.ssh?.sshdFlags?.permitRootLogin ?? null,
    passwordAuthentication: raw.ssh?.sshdFlags?.passwordAuthentication ?? null,
    kbdInteractiveAuthentication: raw.ssh?.sshdFlags?.kbdInteractiveAuthentication ?? null,
    allowUsers: [...(raw.ssh?.sshdFlags?.allowUsers ?? [])],
    port: typeof raw.ssh?.sshdFlags?.port === 'number' ? raw.ssh.sshdFlags.port : 22,
    configSha256: raw.ssh?.sshdFlags?.configSha256 ?? ''.padEnd(64, '0'),
  };
  const ssh: NodeSshExposure = {
    nodeName,
    restrictionMode,
    sshViaMeshFlag: Boolean(raw.ssh?.sshViaMeshFlag),
    enforcedInterface: raw.ssh?.enforcedInterface ?? null,
    sshdFlags,
    parseSucceeded: Boolean(raw.ssh?.parseSucceeded),
    parseError: raw.ssh?.parseError ?? null,
  };

  const cisFindings: CisFinding[] = (raw.hardening?.cisFindings ?? [])
    .filter((f): f is { id: string; severity: string; title: string; observed: string; expected: string; passing: boolean } =>
      typeof f.id === 'string' &&
      typeof f.severity === 'string' &&
      typeof f.title === 'string',
    )
    .map((f) => ({
      id: f.id,
      severity: ALLOWED_SEVERITIES.has(f.severity as CisSeverity) ? (f.severity as CisSeverity) : 'info',
      title: f.title,
      observed: f.observed ?? '',
      expected: f.expected ?? '',
      passing: Boolean(f.passing),
    }));

  const hardening: NodeHardening = {
    nodeName,
    kernelVersion: raw.hardening?.kernelVersion ?? '',
    kernelEol: Boolean(raw.hardening?.kernelEol),
    timeSinceRebootSeconds:
      typeof raw.hardening?.timeSinceRebootSeconds === 'number'
        ? raw.hardening.timeSinceRebootSeconds
        : 0,
    pendingKernelUpdate: Boolean(raw.hardening?.pendingKernelUpdate),
    fail2banPresent: Boolean(raw.hardening?.fail2banPresent),
    sshguardPresent: Boolean(raw.hardening?.sshguardPresent),
    unattendedUpgradesActive: Boolean(raw.hardening?.unattendedUpgradesActive),
    automaticRebootWindow: raw.hardening?.automaticRebootWindow ?? null,
    osPretty: raw.hardening?.osPretty ?? '',
    cisFindings,
  };

  const stale = lastUpdatedAt === null || now.getTime() - new Date(lastUpdatedAt).getTime() > PROBE_STALE_AFTER_MS;

  return {
    name: nodeName,
    lastUpdatedAt,
    stale,
    mesh,
    ssh,
    hardening,
  };
}
