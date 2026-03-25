import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface AuditLogEntry {
  readonly id: string;
  readonly clientId: string | null;
  readonly actionType: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly actorId: string;
  readonly actorType: 'user' | 'system' | 'webhook';
  readonly httpMethod: string | null;
  readonly httpPath: string | null;
  readonly httpStatus: number | null;
  readonly changes: Record<string, unknown> | null;
  readonly ipAddress: string | null;
  readonly createdAt: string;
}

interface AuditLogsResponse {
  readonly data: readonly AuditLogEntry[];
}

export function useAuditLogs(limit = 50) {
  return useQuery({
    queryKey: ['audit-logs', limit],
    queryFn: () => apiFetch<AuditLogsResponse>(`/api/v1/admin/audit-logs?limit=${limit}`),
    refetchInterval: 30_000,
  });
}
