import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  MtlsProviderInput,
  MtlsProviderUpdate,
  MtlsProviderResponse,
  MtlsIssueCertInput,
  MtlsIssueCertResponse,
  CertificateResponse,
  CertificateStatus,
  ListCertificatesResponse,
  RevokeCertificateInput,
  CrlMetadataResponse,
} from '@k8s-hosting/api-contracts';

interface ApiEnvelope<T> {
  readonly data: T;
}

const KEY = (cid: string) => ['mtls-providers', cid] as const;
const CERTS_KEY = (cid: string, pid: string, status?: CertificateStatus | 'all') =>
  ['mtls-providers', cid, pid, 'certificates', status ?? 'all'] as const;
const CRL_KEY = (cid: string, pid: string) =>
  ['mtls-providers', cid, pid, 'crl'] as const;

export function useMtlsProviders(clientId: string | undefined) {
  return useQuery({
    queryKey: KEY(clientId ?? ''),
    queryFn: async () => {
      const res = await apiFetch<ApiEnvelope<MtlsProviderResponse[]>>(
        `/api/v1/clients/${clientId}/mtls-providers`,
      );
      return res.data;
    },
    enabled: Boolean(clientId),
  });
}

export function useCreateMtlsProvider(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: MtlsProviderInput) => {
      const res = await apiFetch<ApiEnvelope<MtlsProviderResponse>>(
        `/api/v1/clients/${clientId}/mtls-providers`,
        { method: 'POST', body: JSON.stringify(input) },
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(clientId) }),
  });
}

export function useUpdateMtlsProvider(clientId: string, providerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: MtlsProviderUpdate) => {
      const res = await apiFetch<ApiEnvelope<MtlsProviderResponse>>(
        `/api/v1/clients/${clientId}/mtls-providers/${providerId}`,
        { method: 'PATCH', body: JSON.stringify(input) },
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(clientId) }),
  });
}

export function useDeleteMtlsProvider(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (providerId: string) => {
      await apiFetch<ApiEnvelope<{ deleted: boolean }>>(
        `/api/v1/clients/${clientId}/mtls-providers/${providerId}`,
        { method: 'DELETE' },
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(clientId) }),
  });
}

export function useIssueMtlsCert(clientId: string, providerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: MtlsIssueCertInput) => {
      const res = await apiFetch<ApiEnvelope<MtlsIssueCertResponse>>(
        `/api/v1/clients/${clientId}/mtls-providers/${providerId}/issue-cert`,
        { method: 'POST', body: JSON.stringify(input) },
      );
      return res.data;
    },
    onSuccess: () => {
      // New cert exists — refresh both the list and the CRL metadata.
      qc.invalidateQueries({ queryKey: ['mtls-providers', clientId, providerId, 'certificates'] });
      qc.invalidateQueries({ queryKey: CRL_KEY(clientId, providerId) });
    },
  });
}

export function useMtlsCertificates(
  clientId: string | undefined,
  providerId: string | undefined,
  status: CertificateStatus | 'all' = 'all',
) {
  return useQuery({
    queryKey: CERTS_KEY(clientId ?? '', providerId ?? '', status),
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (status !== 'all') qs.set('status', status);
      qs.set('limit', '100');
      const res = await apiFetch<ApiEnvelope<ListCertificatesResponse>>(
        `/api/v1/clients/${clientId}/mtls-providers/${providerId}/certificates?${qs.toString()}`,
      );
      return res.data;
    },
    enabled: Boolean(clientId) && Boolean(providerId),
  });
}

export function useRevokeMtlsCertificate(clientId: string, providerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { certId: string; input: RevokeCertificateInput }) => {
      const res = await apiFetch<ApiEnvelope<CertificateResponse>>(
        `/api/v1/clients/${clientId}/mtls-providers/${providerId}/certificates/${vars.certId}/revoke`,
        { method: 'POST', body: JSON.stringify(vars.input) },
      );
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mtls-providers', clientId, providerId, 'certificates'] });
      qc.invalidateQueries({ queryKey: CRL_KEY(clientId, providerId) });
    },
  });
}

export function useMtlsCrlMetadata(clientId: string | undefined, providerId: string | undefined) {
  return useQuery({
    queryKey: CRL_KEY(clientId ?? '', providerId ?? ''),
    queryFn: async () => {
      const res = await apiFetch<ApiEnvelope<CrlMetadataResponse>>(
        `/api/v1/clients/${clientId}/mtls-providers/${providerId}/crl`,
      );
      return res.data;
    },
    enabled: Boolean(clientId) && Boolean(providerId),
  });
}
