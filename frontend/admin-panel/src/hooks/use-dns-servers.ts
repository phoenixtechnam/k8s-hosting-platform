import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface DnsServer {
  readonly id: string;
  readonly displayName: string;
  readonly providerType: string;
  readonly zoneDefaultKind: string;
  readonly isDefault: boolean;
  readonly enabled: boolean;
  readonly lastHealthCheck: string | null;
  readonly lastHealthStatus: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function useDnsServers() {
  return useQuery({
    queryKey: ['dns-servers'],
    queryFn: () => apiFetch<{ data: readonly DnsServer[] }>('/api/v1/admin/dns-servers'),
  });
}

interface CreateDnsServerInput {
  readonly display_name: string;
  readonly provider_type: string;
  readonly connection_config: Record<string, unknown>;
  readonly zone_default_kind?: 'Native' | 'Master';
  readonly is_default?: boolean;
  readonly enabled?: boolean;
}

export function useCreateDnsServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDnsServerInput) =>
      apiFetch<{ data: DnsServer }>('/api/v1/admin/dns-servers', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['dns-servers'] }); },
  });
}

export function useUpdateDnsServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: Partial<CreateDnsServerInput> & { id: string }) =>
      apiFetch<{ data: DnsServer }>(`/api/v1/admin/dns-servers/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['dns-servers'] }); },
  });
}

export function useDeleteDnsServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/api/v1/admin/dns-servers/${id}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['dns-servers'] }); },
  });
}

export function useTestDnsServer() {
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ data: { status: string; message?: string; version?: string } }>(`/api/v1/admin/dns-servers/${id}/test`, { method: 'POST' }),
  });
}
