/**
 * TanStack Query hooks for the cluster-network admin API (Phase 4).
 *
 * Two CRD resource families:
 *   ClusterTrustedRange — operator-blessed source ranges (full TCP/UDP)
 *   ClusterPendingPeer  — pre-authorise a node about to bootstrap (TTL'd)
 *
 * Plus a derived endpoint:
 *   GET /admin/cluster/bootstrap-command/:name → paste-ready bootstrap.sh
 *
 * Every mutation invalidates its sibling list query. Caches are short
 * (15s) since the reconciler rewrites status fields on every tick and
 * the operator wants near-live state.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  TrustedRange,
  PendingPeer,
  CreateTrustedRangeRequest,
  UpdateTrustedRangeRequest,
  CreatePendingPeerRequest,
  BootstrapCommandResponse,
} from '@k8s-hosting/api-contracts';

interface Envelope<T> {
  readonly data: T;
}

const TRUSTED_RANGES_KEY = ['cluster-network', 'trusted-ranges'] as const;
const PENDING_PEERS_KEY = ['cluster-network', 'pending-peers'] as const;

// ─── Trusted ranges ────────────────────────────────────────────────────────

export function useTrustedRanges() {
  return useQuery<Envelope<{ data: TrustedRange[] }>>({
    queryKey: TRUSTED_RANGES_KEY,
    queryFn: () => apiFetch('/api/v1/admin/cluster/trusted-ranges'),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

export function useCreateTrustedRange() {
  const qc = useQueryClient();
  return useMutation<Envelope<TrustedRange>, Error, CreateTrustedRangeRequest>({
    mutationFn: (body) =>
      apiFetch('/api/v1/admin/cluster/trusted-ranges', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: TRUSTED_RANGES_KEY });
    },
  });
}

export function useUpdateTrustedRange() {
  const qc = useQueryClient();
  return useMutation<
    Envelope<TrustedRange>,
    Error,
    { name: string; body: UpdateTrustedRangeRequest }
  >({
    mutationFn: ({ name, body }) =>
      apiFetch(`/api/v1/admin/cluster/trusted-ranges/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: TRUSTED_RANGES_KEY });
    },
  });
}

export function useDeleteTrustedRange() {
  const qc = useQueryClient();
  return useMutation<Envelope<{ deleted: string }>, Error, string>({
    mutationFn: (name) =>
      apiFetch(`/api/v1/admin/cluster/trusted-ranges/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: TRUSTED_RANGES_KEY });
    },
  });
}

// ─── Pending peers ─────────────────────────────────────────────────────────

export function usePendingPeers() {
  return useQuery<Envelope<{ data: PendingPeer[] }>>({
    queryKey: PENDING_PEERS_KEY,
    queryFn: () => apiFetch('/api/v1/admin/cluster/pending-peers'),
    staleTime: 5_000, // tighter — the operator is watching for claim
    refetchInterval: 10_000,
  });
}

export function useCreatePendingPeer() {
  const qc = useQueryClient();
  return useMutation<Envelope<PendingPeer>, Error, CreatePendingPeerRequest>({
    mutationFn: (body) =>
      apiFetch('/api/v1/admin/cluster/pending-peers', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PENDING_PEERS_KEY });
    },
  });
}

export function useDeletePendingPeer() {
  const qc = useQueryClient();
  return useMutation<Envelope<{ deleted: string }>, Error, string>({
    mutationFn: (name) =>
      apiFetch(`/api/v1/admin/cluster/pending-peers/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PENDING_PEERS_KEY });
    },
  });
}

// ─── Bootstrap command ─────────────────────────────────────────────────────

/** One-shot fetch — not a useQuery, since the operator triggers it from
 *  a button click (and seeing stale paste-ready commands would be
 *  confusing). Returns a regular Promise wrapping the apiFetch call. */
export async function fetchBootstrapCommand(cppName: string): Promise<BootstrapCommandResponse> {
  const env = await apiFetch<Envelope<BootstrapCommandResponse>>(
    `/api/v1/admin/cluster/bootstrap-command/${encodeURIComponent(cppName)}`,
  );
  return env.data;
}

// ─── Node exposure toggle (Phase 6) ────────────────────────────────────────

interface SetNodeExposurePayload {
  readonly name: string;
  readonly exposure: 'public' | 'private';
}

/** Toggle a Node's platform.phoenix-host.net/exposure label. Drives
 *  ingress-nginx + cert-manager solver scheduler affinity (manifest-
 *  side); a future Phase 6.5 will add reconciler firewall-chain drops
 *  on private nodes for workload ports. Invalidates the existing
 *  ['cluster-nodes'] query (consumed by the /admin/nodes page) so the
 *  UI re-fetches after the flip. */
export function useToggleNodeExposure() {
  const qc = useQueryClient();
  return useMutation<Envelope<{ name: string; exposure: 'public' | 'private' }>, Error, SetNodeExposurePayload>({
    mutationFn: ({ name, exposure }) =>
      apiFetch(`/api/v1/admin/cluster/nodes/${encodeURIComponent(name)}/exposure`, {
        method: 'PATCH',
        body: JSON.stringify({ exposure }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['cluster-nodes'] });
    },
  });
}
