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

export interface ListAuditLogsParams {
  readonly limit?: number;
  readonly cursor?: string;
  readonly client_id?: string;
  readonly action_type?: string;
  readonly resource_type?: string;
  readonly actor_id?: string;
  readonly http_method?: string;
  readonly search?: string;
  /** ISO timestamp inclusive lower bound */
  readonly from?: string;
  /** ISO timestamp inclusive upper bound */
  readonly to?: string;
}

export function useAuditLogs(params: ListAuditLogsParams = {}) {
  const searchParams = new URLSearchParams();
  if (params.limit) searchParams.set('limit', String(params.limit));
  if (params.cursor) searchParams.set('cursor', params.cursor);
  if (params.client_id) searchParams.set('client_id', params.client_id);
  if (params.action_type) searchParams.set('action_type', params.action_type);
  if (params.resource_type) searchParams.set('resource_type', params.resource_type);
  if (params.actor_id) searchParams.set('actor_id', params.actor_id);
  if (params.http_method) searchParams.set('http_method', params.http_method);
  if (params.search) searchParams.set('search', params.search);
  if (params.from) searchParams.set('from', params.from);
  if (params.to) searchParams.set('to', params.to);

  const qs = searchParams.toString();
  const path = `/api/v1/admin/audit-logs${qs ? `?${qs}` : ''}`;

  return useQuery({
    queryKey: ['audit-logs', params],
    queryFn: () => apiFetch<PaginatedResponse<AuditLogEntry>>(path),
    refetchInterval: 30_000,
  });
}
