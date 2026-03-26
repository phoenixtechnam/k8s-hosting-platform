import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

interface AuditLogEntry {
  readonly id: string;
  readonly actionType: string;
  readonly resourceType: string;
  readonly createdAt: string;
}

interface AuditLogsResponse {
  readonly data: readonly AuditLogEntry[];
}

export function useNotifications(limit = 10) {
  return useQuery({
    queryKey: ['notifications', limit],
    queryFn: () => apiFetch<AuditLogsResponse>(`/api/v1/admin/audit-logs?limit=${limit}`),
    refetchInterval: 60_000,
  });
}
