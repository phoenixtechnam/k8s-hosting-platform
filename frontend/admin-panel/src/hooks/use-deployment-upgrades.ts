// Hooks for the new deployment-version upgrade APIs introduced in PR 0095.
// These replace the older `use-application-upgrades.ts` ApplicationUpgrade
// flow (which targeted an unbuilt API). Both files coexist until the older
// page sections are migrated; new code should use these.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  AvailableUpgradesResponse,
  AdminUpgradesGroup,
  DeploymentResponse,
} from '@k8s-hosting/api-contracts';

// ─── GET /clients/:cid/deployments/:id/available-upgrades ───────────────────

export function useAvailableUpgradesV2(clientId: string | null, deploymentId: string | null) {
  return useQuery({
    queryKey: ['available-upgrades-v2', clientId, deploymentId],
    queryFn: () =>
      apiFetch<{ data: AvailableUpgradesResponse }>(
        `/api/v1/clients/${clientId}/deployments/${deploymentId}/available-upgrades`,
      ).then((r) => r.data),
    enabled: !!(clientId && deploymentId),
    // Catalog versions don't change often; 1-min cache is fine.
    staleTime: 60_000,
  });
}

// ─── PATCH /clients/:cid/deployments/:id/version ────────────────────────────

interface UpgradeVersionInput {
  readonly clientId: string;
  readonly deploymentId: string;
  readonly targetVersion: string;
  readonly force?: boolean;
}

export function useUpgradeDeploymentVersion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clientId, deploymentId, targetVersion, force }: UpgradeVersionInput) =>
      apiFetch<{ data: DeploymentResponse }>(
        `/api/v1/clients/${clientId}/deployments/${deploymentId}/version`,
        {
          method: 'PATCH',
          body: JSON.stringify({ target_version: targetVersion, force }),
        },
      ).then((r) => r.data),
    onSuccess: (_data, vars) => {
      // Invalidate every list that might surface the version change.
      qc.invalidateQueries({ queryKey: ['admin-upgrades-overview'] });
      qc.invalidateQueries({ queryKey: ['admin-deployments'] });
      qc.invalidateQueries({ queryKey: ['available-upgrades-v2', vars.clientId, vars.deploymentId] });
      qc.invalidateQueries({ queryKey: ['deployments', vars.clientId] });
      qc.invalidateQueries({ queryKey: ['deployment', vars.deploymentId] });
    },
  });
}

// ─── POST /clients/:cid/deployments/:id/rollback-version ────────────────────

interface RollbackInput {
  readonly clientId: string;
  readonly deploymentId: string;
}

export function useRollbackDeploymentVersion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clientId, deploymentId }: RollbackInput) =>
      apiFetch<{ data: DeploymentResponse }>(
        `/api/v1/clients/${clientId}/deployments/${deploymentId}/rollback-version`,
        { method: 'POST' },
      ).then((r) => r.data),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['admin-upgrades-overview'] });
      qc.invalidateQueries({ queryKey: ['admin-deployments'] });
      qc.invalidateQueries({ queryKey: ['available-upgrades-v2', vars.clientId, vars.deploymentId] });
      qc.invalidateQueries({ queryKey: ['deployments', vars.clientId] });
    },
  });
}

// ─── PATCH /clients/:cid/deployments/:id/auto-upgrade ───────────────────────

export function useSetAutoUpgrade() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clientId, deploymentId, enabled }: { clientId: string; deploymentId: string; enabled: boolean }) =>
      apiFetch<{ data: DeploymentResponse }>(
        `/api/v1/clients/${clientId}/deployments/${deploymentId}/auto-upgrade`,
        { method: 'PATCH', body: JSON.stringify({ enabled }) },
      ).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-upgrades-overview'] });
      qc.invalidateQueries({ queryKey: ['admin-deployments'] });
    },
  });
}

// ─── GET /admin/upgrades/overview ───────────────────────────────────────────

export function useAdminUpgradesOverview() {
  return useQuery({
    queryKey: ['admin-upgrades-overview'],
    queryFn: () =>
      apiFetch<{ data: readonly AdminUpgradesGroup[] }>(`/api/v1/admin/upgrades/overview`).then(
        (r) => r.data,
      ),
    // Refresh every 30s so the page reflects ongoing pending → running
    // transitions without a manual reload.
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}

// ─── POST /admin/deployments/bulk-upgrade ───────────────────────────────────

interface BulkUpgradeInput {
  readonly deploymentIds: readonly string[];
  readonly targetVersion: string;
  readonly force?: boolean;
}

export interface BulkUpgradeResult {
  readonly succeeded: number;
  readonly failed: number;
  readonly total: number;
  readonly errors: ReadonlyArray<{ deploymentId: string; error: string; code?: string }>;
}

export function useBulkUpgrade() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ deploymentIds, targetVersion, force }: BulkUpgradeInput) =>
      apiFetch<{ data: BulkUpgradeResult }>(`/api/v1/admin/deployments/bulk-upgrade`, {
        method: 'POST',
        body: JSON.stringify({
          deployment_ids: deploymentIds,
          target_version: targetVersion,
          force,
        }),
      }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-upgrades-overview'] });
      qc.invalidateQueries({ queryKey: ['admin-deployments'] });
    },
  });
}

// ─── POST /admin/deployments/:id/rollback-version ───────────────────────────

export function useAdminRollback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ deploymentId }: { deploymentId: string }) =>
      apiFetch<{ data: DeploymentResponse }>(
        `/api/v1/admin/deployments/${deploymentId}/rollback-version`,
        { method: 'POST' },
      ).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-upgrades-overview'] });
      qc.invalidateQueries({ queryKey: ['admin-deployments'] });
    },
  });
}
