import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { SslCertResponse, UploadSslCertInput } from '@k8s-hosting/api-contracts';

function basePath(clientId: string, domainId: string) {
  return `/api/v1/clients/${clientId}/domains/${domainId}/ssl-cert`;
}

export function useSslCert(clientId: string | undefined, domainId: string | undefined) {
  return useQuery({
    queryKey: ['ssl-cert', clientId, domainId],
    queryFn: () => apiFetch<{ data: SslCertResponse }>(basePath(clientId!, domainId!)),
    enabled: Boolean(clientId && domainId),
    retry: false, // 404 means no cert — don't retry
  });
}

export function useUploadSslCert(clientId: string | undefined, domainId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UploadSslCertInput) =>
      apiFetch<{ data: SslCertResponse }>(basePath(clientId!, domainId!), {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ssl-cert', clientId, domainId] });
    },
  });
}

export function useDeleteSslCert(clientId: string | undefined, domainId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      apiFetch<void>(basePath(clientId!, domainId!), { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ssl-cert', clientId, domainId] });
    },
  });
}
