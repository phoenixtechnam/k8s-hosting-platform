/**
 * System Backup hooks (Phase 1: secrets bundle export).
 *
 * Wires the admin panel to /api/v1/system-backup/secrets/* endpoints.
 *
 * Auth model: every endpoint except /download/:token is super_admin
 * gated server-side. The download endpoint is unauthenticated by
 * design — the one-shot HMAC token in the URL IS the auth.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  SystemBackupRun,
  ExportSecretsBundleRequest,
  ExportSecretsBundleResponse,
  SecretsBundleManifestResponse,
} from '@k8s-hosting/api-contracts';

// API envelope used by all admin endpoints.
interface ApiEnv<T> { data: T }

const KEYS = {
  manifest: ['system-backup', 'secrets', 'manifest'] as const,
  runs: ['system-backup', 'secrets', 'runs'] as const,
  run: (id: string) => ['system-backup', 'secrets', 'runs', id] as const,
};

export function useSecretsBundleManifest() {
  return useQuery({
    queryKey: KEYS.manifest,
    queryFn: () => apiFetch<ApiEnv<SecretsBundleManifestResponse>>('/api/v1/system-backup/secrets/manifest')
      .then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useSecretsBundleRuns() {
  return useQuery({
    queryKey: KEYS.runs,
    queryFn: () => apiFetch<ApiEnv<SystemBackupRun[]>>('/api/v1/system-backup/secrets/runs')
      .then((r) => r.data),
    refetchInterval: 5_000, // catch the pending → running → succeeded transitions live
  });
}

export function useSecretsBundleRun(runId: string | null) {
  return useQuery({
    queryKey: runId ? KEYS.run(runId) : ['system-backup', 'secrets', 'runs', '_none'],
    queryFn: async () => {
      if (!runId) return null;
      const r = await apiFetch<ApiEnv<SystemBackupRun>>(`/api/v1/system-backup/secrets/runs/${runId}`);
      return r.data;
    },
    enabled: !!runId,
    refetchInterval: (query) => {
      const v = query.state.data;
      // Stop polling when terminal — no point hammering the server, and
      // refetching consumes the one-shot download URL on the GET path
      // even though the server only marks it consumed via the dedicated
      // download endpoint.
      return v && (v.status === 'succeeded' || v.status === 'failed') ? false : 2_000;
    },
  });
}

export function useTriggerSecretsBundleExport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ExportSecretsBundleRequest = {}) =>
      apiFetch<ApiEnv<ExportSecretsBundleResponse>>('/api/v1/system-backup/secrets/export', {
        method: 'POST',
        body: JSON.stringify(input),
      }).then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEYS.runs });
    },
  });
}
