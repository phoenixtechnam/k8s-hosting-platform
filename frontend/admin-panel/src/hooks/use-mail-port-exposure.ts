import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  MailPortExposureResponse,
  MailPortExposureUpdate,
} from '@k8s-hosting/api-contracts';

interface PortExposureEnvelope {
  readonly data: MailPortExposureResponse;
}

const PORT_EXPOSURE_KEY = ['mail', 'port-exposure'] as const;

export function useMailPortExposure() {
  return useQuery({
    queryKey: PORT_EXPOSURE_KEY,
    queryFn: () => apiFetch<PortExposureEnvelope>('/api/v1/admin/mail/port-exposure'),
    staleTime: 15_000,
    retry: false,
  });
}

export function useUpdateMailPortExposure() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MailPortExposureUpdate) =>
      apiFetch<PortExposureEnvelope>('/api/v1/admin/mail/port-exposure', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: PORT_EXPOSURE_KEY }),
  });
}
