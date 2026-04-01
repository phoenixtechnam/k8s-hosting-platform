import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { IngressRouteResponse } from '@k8s-hosting/api-contracts';

interface RouteListResponse {
  readonly data: readonly IngressRouteResponse[];
}

export function useIngressRoutes(clientId: string | undefined, domainId: string | undefined) {
  return useQuery({
    queryKey: ['ingress-routes', clientId, domainId],
    queryFn: () =>
      apiFetch<RouteListResponse>(
        `/api/v1/clients/${clientId}/domains/${domainId}/routes`,
      ),
    enabled: !!clientId && !!domainId,
    staleTime: 30_000,
  });
}

export function useCreateIngressRoute(clientId: string | undefined, domainId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { hostname: string; deployment_id?: string | null }) =>
      apiFetch<{ data: IngressRouteResponse }>(
        `/api/v1/clients/${clientId}/domains/${domainId}/routes`,
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ingress-routes', clientId, domainId] });
    },
  });
}

export function useUpdateIngressRoute(clientId: string | undefined, domainId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ routeId, ...input }: { routeId: string; deployment_id?: string | null }) =>
      apiFetch<{ data: IngressRouteResponse }>(
        `/api/v1/clients/${clientId}/domains/${domainId}/routes/${routeId}`,
        { method: 'PATCH', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ingress-routes', clientId, domainId] });
    },
  });
}

export function useDeleteIngressRoute(clientId: string | undefined, domainId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (routeId: string) =>
      apiFetch<void>(
        `/api/v1/clients/${clientId}/domains/${domainId}/routes/${routeId}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ingress-routes', clientId, domainId] });
    },
  });
}
