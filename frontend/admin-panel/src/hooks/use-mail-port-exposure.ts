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
    // Mode flip changes which path serves mail traffic (Stalwart
    // hostPort vs. haproxy DS). Both the port-exposure card AND the
    // MailHealthBanner read derived state from the health endpoint
    // (probe reachability, DS readiness). Invalidate both so the
    // operator sees consistent state immediately, not after the 30s
    // health staleTime expires.
    //
    // Return the awaited Promise.all so TanStack Query holds the
    // mutation as `isPending` until the invalidations have actually
    // queued — without that, the component can re-render between the
    // mutation settling and the cache being marked stale, which
    // racy-flashes "succeeded" with the OLD data still in view.
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: PORT_EXPOSURE_KEY }),
      qc.invalidateQueries({ queryKey: ['mail', 'health'] }),
    ]),
  });
}
