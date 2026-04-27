import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, useCallback } from 'react';
import { apiFetch } from '@/lib/api-client';
import type {
  DeploymentUpgradeResponse,
  CatalogEntryVersionResponse,
  DeploymentResponse,
} from '@k8s-hosting/api-contracts';

type ApplicationUpgradeResponse = DeploymentUpgradeResponse;
type AvailableUpgrade = CatalogEntryVersionResponse;
type ApplicationInstanceResponse = DeploymentResponse;

// ─── Response wrappers ──────────────────────────────────────────────────────

interface UpgradeListResponse {
  readonly data: readonly ApplicationUpgradeResponse[];
}

interface AvailableUpgradesResponse {
  readonly data: readonly AvailableUpgrade[];
}

interface InstanceListResponse {
  readonly data: readonly ApplicationInstanceResponse[];
}

// ─── Admin Deployments ──────────────────────────────────────────────────────

export interface AdminDeployment {
  readonly id: string;
  readonly name: string;
  readonly clientId: string;
  readonly clientName: string | null;
  readonly catalogEntryId: string;
  readonly catalogEntryName: string | null;
  readonly catalogEntryCode: string | null;
  readonly catalogEntryType: string | null;
  readonly status: string;
  readonly statusMessage: string | null;
  readonly lastError: string | null;
  readonly cpuRequest: string;
  readonly memoryRequest: string;
  readonly storagePath: string | null;
  readonly installedVersion: string | null;
  readonly replicaCount: number;
  /** Cluster node currently hosting the deployment's first scheduled pod. */
  readonly currentNodeName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface AdminDeploymentsResponse {
  readonly data: readonly AdminDeployment[];
  readonly pagination: {
    readonly page: number;
    readonly page_size: number;
    readonly total_count: number;
    readonly total_pages: number;
    readonly has_more: boolean;
  };
}

export function useAdminDeployments(params?: { page?: number; limit?: number; status?: string; catalog_entry_id?: string; client_id?: string }) {
  const query = new URLSearchParams();
  if (params?.page) query.set('page', String(params.page));
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.status) query.set('status', String(params.status));
  if (params?.catalog_entry_id) query.set('catalog_entry_id', params.catalog_entry_id);
  if (params?.client_id) query.set('client_id', params.client_id);
  const qs = query.toString();

  return useQuery({
    queryKey: ['admin-deployments', qs],
    queryFn: () => apiFetch<AdminDeploymentsResponse>(`/api/v1/admin/deployments${qs ? '?' + qs : ''}`),
    staleTime: 15_000,
    refetchInterval: 15_000,
  });
}

// ─── Bulk Actions ───────────────────────────────────────────────────────────

export function useBulkStartDeployments() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => apiFetch('/api/v1/admin/deployments/bulk-start', { method: 'POST', body: JSON.stringify({ deployment_ids: ids }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-deployments'] }); },
  });
}

export function useBulkStopDeployments() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => apiFetch('/api/v1/admin/deployments/bulk-stop', { method: 'POST', body: JSON.stringify({ deployment_ids: ids }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-deployments'] }); },
  });
}

export function useBulkDeleteDeployments() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => apiFetch('/api/v1/admin/deployments/bulk-delete', { method: 'POST', body: JSON.stringify({ deployment_ids: ids }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-deployments'] }); },
  });
}

// ─── Instances (deprecated — use useAdminDeployments) ───────────────────────

/** @deprecated Use useAdminDeployments instead */
export function useApplicationInstances() {
  return useQuery({
    queryKey: ['application-instances'],
    queryFn: () => apiFetch<InstanceListResponse>('/api/v1/admin/application-instances'),
    staleTime: 30_000,
  });
}

// ─── Upgrade jobs ───────────────────────────────────────────────────────────

export function useApplicationUpgrades(params?: {
  status?: string;
  instanceId?: string;
  limit?: number;
}) {
  const qs = new URLSearchParams();
  if (params?.status) qs.set('status', params.status);
  if (params?.instanceId) qs.set('instanceId', params.instanceId);
  if (params?.limit) qs.set('limit', String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';

  return useQuery({
    queryKey: ['application-upgrades', params],
    queryFn: () => apiFetch<UpgradeListResponse>(`/api/v1/admin/application-upgrades${suffix}`),
    staleTime: 10_000,
  });
}

// ─── Available upgrades for an instance ─────────────────────────────────────

export function useAvailableUpgrades(instanceId: string | null) {
  return useQuery({
    queryKey: ['available-upgrades', instanceId],
    queryFn: () =>
      apiFetch<AvailableUpgradesResponse>(
        `/api/v1/admin/application-instances/${instanceId}/available-upgrades`,
      ),
    enabled: !!instanceId,
    staleTime: 60_000,
  });
}

// ─── Trigger single upgrade ─────────────────────────────────────────────────

export function useTriggerUpgrade() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ instanceId, toVersion }: { instanceId: string; toVersion: string }) =>
      apiFetch<{ data: ApplicationUpgradeResponse }>(
        `/api/v1/admin/application-instances/${instanceId}/upgrade`,
        {
          method: 'POST',
          body: JSON.stringify({ toVersion }),
        },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['application-instances'] });
      queryClient.invalidateQueries({ queryKey: ['application-upgrades'] });
      queryClient.invalidateQueries({ queryKey: ['available-upgrades'] });
    },
  });
}

// ─── Batch upgrade ──────────────────────────────────────────────────────────

export function useBatchUpgrade() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ instanceIds, toVersion }: { instanceIds: string[]; toVersion: string }) =>
      apiFetch<{ data: { instanceId: string; upgradeId?: string; error?: string }[] }>(
        '/api/v1/admin/application-upgrades/batch',
        {
          method: 'POST',
          body: JSON.stringify({ instanceIds, toVersion }),
        },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['application-instances'] });
      queryClient.invalidateQueries({ queryKey: ['application-upgrades'] });
    },
  });
}

// ─── Rollback ───────────────────────────────────────────────────────────────

export function useRollbackUpgrade() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (upgradeId: string) =>
      apiFetch<{ data: ApplicationUpgradeResponse }>(
        `/api/v1/admin/application-upgrades/${upgradeId}/rollback`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['application-upgrades'] });
      queryClient.invalidateQueries({ queryKey: ['application-instances'] });
    },
  });
}

// ─── SSE Progress Hook ──────────────────────────────────────────────────────

interface UpgradeProgressEvent {
  readonly id: string;
  readonly status: string;
  readonly progressPct: number;
  readonly statusMessage: string | null;
  readonly errorMessage: string | null;
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'rolled_back']);

export function useUpgradeProgress(upgradeId: string | null) {
  const [progress, setProgress] = useState<UpgradeProgressEvent | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const queryClient = useQueryClient();

  const close = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!upgradeId) {
      close();
      setProgress(null);
      return;
    }

    const token = localStorage.getItem('auth_token');
    const url = `/api/v1/admin/application-upgrades/${upgradeId}/progress?token=${encodeURIComponent(token ?? '')}`;

    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as UpgradeProgressEvent;
        setProgress(data);

        if (TERMINAL_STATUSES.has(data.status)) {
          es.close();
          eventSourceRef.current = null;
          queryClient.invalidateQueries({ queryKey: ['application-instances'] });
          queryClient.invalidateQueries({ queryKey: ['application-upgrades'] });
        }
      } catch {
        // Ignore malformed events
      }
    };

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [upgradeId, close, queryClient]);

  return { progress, close };
}
