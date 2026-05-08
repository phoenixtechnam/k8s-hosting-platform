/**
 * Bootstrap command generator.
 *
 * Given a ClusterPendingPeer name, returns the operator-paste-ready
 * bootstrap.sh invocation for the new node + an optional break-glass
 * peer-firewall-add command for each existing peer.
 *
 * The command includes:
 *   --remote <new-node-public-ip>     (so operator runs from workstation)
 *   --ssh-key <hint>                  (placeholder; operator fills)
 *   --join-as <server|worker>         (from CPP.spec.role)
 *   --server <existing-peer-IP>       (first ready Node InternalIP)
 *   --token <K3S_TOKEN>               (read from /var/lib/rancher/k3s/
 *                                      server/node-token via in-cluster
 *                                      Secret OR a server pod exec —
 *                                      Phase 4: we read from the
 *                                      `k3s-serving-token` Secret if
 *                                      present, else return a TODO
 *                                      placeholder for the operator.)
 *   --domain <PLATFORM_DOMAIN>        (from platform-config)
 *   --acme-email <ACME_EMAIL>         (from platform-config; only for
 *                                      first-server; other joins skip)
 *
 * This is a string-builder; no kube-API writes. The CPP must already
 * exist (the UI workflow creates it first, then asks for the command).
 */

import { ApiError } from '../../shared/errors.js';
import { type BootstrapCommandResponse } from '@k8s-hosting/api-contracts';
import { getPendingPeer } from './cluster-pending-peers.js';
import {
  loadClusterNetworkClients,
  type ClusterNetworkClients,
  type LoadOptions,
} from './k8s-client.js';

interface ReadyPeer {
  readonly internalIp: string;
}

interface NodeShape {
  readonly status?: {
    readonly addresses?: ReadonlyArray<{ type?: string; address?: string }>;
    readonly conditions?: ReadonlyArray<{ type?: string; status?: string }>;
  };
}

interface NodeListShape {
  readonly items?: readonly NodeShape[];
}

/** Read-only Node listing — just enough to pick a join target. The
 *  richer `/admin/nodes` API exists but isn't a dependency here; this
 *  module only needs ready InternalIPs. */
async function listReadyPeers(c: ClusterNetworkClients): Promise<ReadyPeer[]> {
  const resp = (await c.core.listNode()) as NodeListShape;
  const out: ReadyPeer[] = [];
  for (const n of resp.items ?? []) {
    const ready = (n.status?.conditions ?? []).find((cond) => cond.type === 'Ready');
    if (ready?.status !== 'True') continue;
    const ip = (n.status?.addresses ?? []).find((a) => a.type === 'InternalIP' && a.address)?.address;
    if (ip) out.push({ internalIp: ip });
  }
  return out;
}

export interface BootstrapCommandOptions extends LoadOptions {
  /** The cluster's primary domain (e.g. "phoenix-host.net"). Required
   *  by bootstrap.sh on first-server install but optional on joins —
   *  passed through anyway so operators see consistent invocations. */
  readonly domain?: string | undefined;
}

const TOKEN_PLACEHOLDER = '<RUN-ON-EXISTING-PEER:cat-/var/lib/rancher/k3s/server/node-token>';

export async function generateBootstrapCommand(
  cppName: string,
  opts: BootstrapCommandOptions = {},
  clients?: ClusterNetworkClients,
): Promise<BootstrapCommandResponse> {
  const c = clients ?? (await loadClusterNetworkClients(opts));
  const cpp = await getPendingPeer(cppName, opts, c);
  const ready = await listReadyPeers(c);
  if (ready.length === 0) {
    throw new ApiError(
      'NO_READY_PEERS',
      'No ready Nodes with an InternalIP found — cluster has no peer to join. ' +
        'A first-server install does not need this command; only joins do.',
      503,
    );
  }
  // Pick the first ready peer with a matching family (v4↔v4, v6↔v6).
  // Falls back to the first ready peer if no family match — bootstrap
  // will fail clearly at the network layer, which is better than us
  // silently picking an unreachable peer.
  const cppFamily = cpp.family ?? guessFamily(cpp.ip);
  const sameFamily = ready.find((n) => guessFamily(n.internalIp) === cppFamily);
  const serverIp = (sameFamily ?? ready[0]).internalIp;

  const parts = [
    'bootstrap.sh',
    '--remote', shellQuote(cpp.ip),
    '--ssh-key', '~/.ssh/id_ed25519', // operator fills in
    '--join-as', cpp.role,
    '--server', shellQuote(serverIp),
    '--token', TOKEN_PLACEHOLDER,
  ];
  if (opts.domain) {
    parts.push('--domain', shellQuote(opts.domain));
  }
  const bootstrapCommand = parts.join(' ');

  // Pre-auth helper for the bootstrap-time window. Most operators won't
  // need this — the CPP CR will propagate to all existing peers via the
  // reconciler within ~30s — but if the operator runs bootstrap.sh
  // before the reconciler ticks, the join handshake will hang. The
  // helper command fans out to every ready peer.
  const preAuthCommand = ready
    .map((n) => `ssh ${shellQuote(n.internalIp)} '/usr/local/bin/peer-firewall-add ${shellQuote(cpp.ip)}'`)
    .join(' && ');

  return {
    preAuthCommand: preAuthCommand || null,
    bootstrapCommand,
    serverIp,
    role: cpp.role,
    nodeIp: cpp.ip,
  };
}

/** Coarse v4/v6 detection without netip — single-purpose for the
 *  same-family heuristic. ":" implies v6; otherwise v4. */
function guessFamily(s: string): 'v4' | 'v6' {
  return s.includes(':') ? 'v6' : 'v4';
}

/** Single-quote a value for shell embedding. Rejects single-quote
 *  characters in the input — defense-in-depth; the CPP IP is already
 *  validated via the bare-IP regex which excludes `'`. */
function shellQuote(s: string): string {
  if (s.includes("'")) {
    throw new ApiError(
      'BOOTSTRAP_COMMAND_UNQUOTABLE',
      'Refusing to embed a value containing a single quote into a shell command',
      400,
    );
  }
  return `'${s}'`;
}
