/**
 * Client-panel hooks for self-service Tenant Backup. Reads from
 * /api/v1/client/backups/* — the JWT carries the clientId so the
 * hooks don't need it as a parameter.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  BundleSummary,
  ClientBackupSchedule,
  UpdateClientBackupScheduleInput,
} from '@k8s-hosting/api-contracts';

interface BundlesResponse { readonly data: readonly BundleSummary[] }
interface ScheduleResponse { readonly data: ClientBackupSchedule | null }

export function useTenantBundles() {
  return useQuery({
    queryKey: ['tenant-backups', 'bundles'],
    queryFn: () => apiFetch<BundlesResponse>('/api/v1/client/backups/bundles'),
  });
}

export function useTenantSchedule() {
  return useQuery({
    queryKey: ['tenant-backups', 'schedule'],
    queryFn: () => apiFetch<ScheduleResponse>('/api/v1/client/backups/schedule'),
  });
}

export function useUpdateTenantSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateClientBackupScheduleInput) =>
      apiFetch<ScheduleResponse>('/api/v1/client/backups/schedule', {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tenant-backups', 'schedule'] }),
  });
}

/**
 * Trigger a browser download of the encrypted GDPR data-export
 * tarball for one bundle. Pattern mirrors the admin-panel hook —
 * fetch + Blob + URL.createObjectURL because <a href> can't carry
 * the Bearer header.
 */
export async function downloadTenantDataExport(bundleId: string): Promise<void> {
  const token = localStorage.getItem('auth_token');
  const r = await fetch(`/api/v1/client/backups/bundles/${bundleId}/data-export`, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!r.ok) {
    let detail = '';
    try { detail = await r.text(); } catch { /* ignore */ }
    throw new Error(`download failed (${r.status}): ${detail.slice(0, 200)}`);
  }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `data-export-${bundleId}.tar.gz.enc`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
