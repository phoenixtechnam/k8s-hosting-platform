import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { ApplicationCatalogResponse } from '@k8s-hosting/api-contracts';

interface ApplicationCatalogListResponse {
  readonly data: readonly ApplicationCatalogResponse[];
}

export function useApplicationCatalog() {
  return useQuery({
    queryKey: ['application-catalog'],
    queryFn: () => apiFetch<ApplicationCatalogListResponse>('/api/v1/admin/application-catalog'),
    staleTime: 60_000,
  });
}

interface UpdateBadgesInput {
  readonly id: string;
  readonly featured?: boolean;
  readonly popular?: boolean;
}

export function useUpdateBadges() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...body }: UpdateBadgesInput) =>
      apiFetch<{ data: ApplicationCatalogResponse }>(`/api/v1/admin/application-catalog/${id}/badges`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['application-catalog'] });
    },
  });
}
