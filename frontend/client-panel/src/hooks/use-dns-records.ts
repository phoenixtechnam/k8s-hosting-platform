import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { DnsRecordResponse } from '@/types/api';

function basePath(clientId: string, domainId: string) {
  return `/api/v1/clients/${clientId}/domains/${domainId}/dns-records`;
}

export function useDnsRecords(clientId: string | undefined, domainId: string | undefined) {
  return useQuery({
    queryKey: ['dns-records', clientId, domainId],
    queryFn: () => apiFetch<{ data: readonly DnsRecordResponse[] }>(basePath(clientId!, domainId!)),
    enabled: Boolean(clientId && domainId),
  });
}

interface CreateDnsRecordInput {
  readonly record_type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'SRV' | 'NS';
  readonly record_name?: string;
  readonly record_value: string;
  readonly ttl?: number;
  readonly priority?: number;
}

export function useCreateDnsRecord(clientId: string | undefined, domainId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDnsRecordInput) =>
      apiFetch<{ data: DnsRecordResponse }>(basePath(clientId!, domainId!), {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dns-records', clientId, domainId] });
    },
  });
}

interface UpdateDnsRecordInput {
  readonly record_value?: string;
  readonly ttl?: number;
  readonly priority?: number;
}

export function useUpdateDnsRecord(clientId: string | undefined, domainId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ recordId, ...input }: UpdateDnsRecordInput & { readonly recordId: string }) =>
      apiFetch<{ data: DnsRecordResponse }>(`${basePath(clientId!, domainId!)}/${recordId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dns-records', clientId, domainId] });
    },
  });
}

export function useDeleteDnsRecord(clientId: string | undefined, domainId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (recordId: string) =>
      apiFetch<void>(`${basePath(clientId!, domainId!)}/${recordId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dns-records', clientId, domainId] });
    },
  });
}

export function useSyncDnsRecords(clientId: string | undefined, domainId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: readonly DnsRecordResponse[] }>(`${basePath(clientId!, domainId!)}/sync`, {
        method: 'POST',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dns-records', clientId, domainId] });
    },
  });
}

export interface DnsRecordDiffEntry {
  readonly type: string;
  readonly name: string;
  readonly local: { value: string; ttl: number; id: string } | null;
  readonly remote: { value: string; ttl: number } | null;
  readonly status: 'in_sync' | 'conflict' | 'local_only' | 'remote_only';
}

export function useDnsRecordDiff(clientId: string | undefined, domainId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['dns-record-diff', clientId, domainId],
    queryFn: () => apiFetch<{ data: readonly DnsRecordDiffEntry[] }>(
      `${basePath(clientId!, domainId!)}/diff`
    ),
    enabled: Boolean(clientId && domainId) && enabled,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  });
}

export function usePullDnsRecord(clientId: string | undefined, domainId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { type: string; name: string; value: string; ttl?: number; local_id?: string }) =>
      apiFetch(`${basePath(clientId!, domainId!)}/pull`, {
        method: 'POST', body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dns-records'] });
      qc.invalidateQueries({ queryKey: ['dns-record-diff'] });
    },
  });
}

export function usePushDnsRecord(clientId: string | undefined, domainId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { type: string; name: string; value: string; ttl?: number }) =>
      apiFetch(`${basePath(clientId!, domainId!)}/push`, {
        method: 'POST', body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dns-record-diff'] });
    },
  });
}
