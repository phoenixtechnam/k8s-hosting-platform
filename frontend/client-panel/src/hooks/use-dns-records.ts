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
