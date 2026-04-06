import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

// ─── DNS Servers ────────────────────────────────────────────────────────────

export interface DnsServer {
  readonly id: string;
  readonly displayName: string;
  readonly providerType: string;
  readonly zoneDefaultKind: string;
  readonly groupId: string | null;
  readonly role: string;
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
  readonly group_id?: string;
  readonly role?: 'primary' | 'secondary';
}

export function useCreateDnsServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDnsServerInput) =>
      apiFetch<{ data: DnsServer }>('/api/v1/admin/dns-servers', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dns-servers'] });
      qc.invalidateQueries({ queryKey: ['dns-provider-groups'] });
    },
  });
}

export function useUpdateDnsServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: Partial<CreateDnsServerInput> & { id: string }) =>
      apiFetch<{ data: DnsServer }>(`/api/v1/admin/dns-servers/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dns-servers'] });
      qc.invalidateQueries({ queryKey: ['dns-provider-groups'] });
    },
  });
}

export function useDeleteDnsServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/api/v1/admin/dns-servers/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dns-servers'] });
      qc.invalidateQueries({ queryKey: ['dns-provider-groups'] });
    },
  });
}

export function useTestDnsServer() {
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ data: { status: string; message?: string; version?: string } }>(`/api/v1/admin/dns-servers/${id}/test`, { method: 'POST' }),
  });
}

// ─── DNS Provider Groups ────────────────────────────────────────────────────

export interface DnsProviderGroup {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly nsHostnames: readonly string[] | null;
  readonly serverCount?: number;
  readonly domainCount?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function useDnsProviderGroups() {
  return useQuery({
    queryKey: ['dns-provider-groups'],
    queryFn: () => apiFetch<{ data: readonly DnsProviderGroup[] }>('/api/v1/admin/dns-provider-groups'),
  });
}

interface CreateDnsProviderGroupInput {
  readonly name: string;
  readonly is_default?: boolean;
  readonly ns_hostnames?: string[];
}

export function useCreateDnsProviderGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDnsProviderGroupInput) =>
      apiFetch<{ data: DnsProviderGroup }>('/api/v1/admin/dns-provider-groups', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['dns-provider-groups'] }); },
  });
}

export function useUpdateDnsProviderGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: Partial<CreateDnsProviderGroupInput> & { id: string }) =>
      apiFetch<{ data: DnsProviderGroup }>(`/api/v1/admin/dns-provider-groups/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['dns-provider-groups'] }); },
  });
}

export function useDeleteDnsProviderGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/api/v1/admin/dns-provider-groups/${id}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['dns-provider-groups'] }); },
  });
}
