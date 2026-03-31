import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { PaginatedResponse } from '@/types/api';

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

interface ListAuditLogsParams {
  readonly limit?: number;
  readonly cursor?: string;
}

export function useAuditLogs(params: ListAuditLogsParams = {}) {
  const searchParams = new URLSearchParams();
  if (params.limit) searchParams.set('limit', String(params.limit));
  if (params.cursor) searchParams.set('cursor', params.cursor);

  const qs = searchParams.toString();
  const path = `/api/v1/admin/audit-logs${qs ? `?${qs}` : ''}`;

  return useQuery({
    queryKey: ['audit-logs', params],
    queryFn: () => apiFetch<PaginatedResponse<AuditLogEntry>>(path),
    refetchInterval: 30_000,
  });
}
