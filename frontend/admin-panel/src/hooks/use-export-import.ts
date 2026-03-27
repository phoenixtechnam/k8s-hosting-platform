import { useMutation } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

interface ExportResponse {
  readonly data: {
    readonly version: string;
    readonly exportedAt: string;
    readonly clients: readonly Record<string, unknown>[];
    readonly domains: readonly Record<string, unknown>[];
    readonly hostingPlans: readonly Record<string, unknown>[];
    readonly dnsServers: readonly Record<string, unknown>[];
  };
}

interface ImportResult {
  readonly data: {
    readonly dryRun: boolean;
    readonly created: number;
    readonly updated: number;
    readonly skipped: number;
    readonly errors: readonly { resource: string; id: string; error: string }[];
  };
}

export function useExport() {
  return useMutation({
    mutationFn: () => apiFetch<ExportResponse>('/api/v1/admin/export'),
  });
}

export function useImport() {
  return useMutation({
    mutationFn: (input: { data: Record<string, unknown>; dryRun: boolean }) =>
      apiFetch<ImportResult>(
        `/api/v1/admin/import${input.dryRun ? '?dry_run=true' : ''}`,
        { method: 'POST', body: JSON.stringify(input.data) },
      ),
  });
}
