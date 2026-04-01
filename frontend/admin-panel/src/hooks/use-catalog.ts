import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface CatalogEntry {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly type: 'application' | 'runtime' | 'database' | 'service' | 'static';
  readonly version: string | null;
  readonly description: string | null;
  readonly category: string | null;
  readonly tags: string[] | null;
  readonly components: ReadonlyArray<{
    readonly name: string;
    readonly type: string;
    readonly image: string;
    readonly ports?: ReadonlyArray<{ readonly port: number; readonly protocol: string; readonly ingress?: boolean }>;
    readonly optional?: boolean;
  }> | null;
  readonly resources: {
    readonly default: { readonly cpu: string; readonly memory: string; readonly storage?: string };
    readonly minimum: { readonly cpu: string; readonly memory: string; readonly storage?: string };
  } | null;
  readonly status: string;
  readonly featured: number;
  readonly popular: number;
  readonly url: string | null;
  readonly documentation: string | null;
  readonly manifestUrl: string | null;
  readonly parameters: unknown;
  readonly networking: unknown;
  readonly volumes: unknown;
  readonly healthCheck: unknown;
  readonly sourceRepoId: string | null;
  readonly registryUrl: string | null;
  readonly imageType: string | null;
  readonly createdAt: string;
}

interface CatalogListResponse {
  readonly data: readonly CatalogEntry[];
  readonly pagination: {
    readonly total_count: number;
    readonly cursor: string | null;
    readonly has_more: boolean;
    readonly page_size: number;
  };
}

interface CatalogSingleResponse {
  readonly data: CatalogEntry;
}

export function useCatalog(type?: string) {
  const params = new URLSearchParams();
  if (type) params.set('type', type);
  params.set('limit', '100');
  const qs = params.toString();

  return useQuery({
    queryKey: ['catalog', type],
    queryFn: () => apiFetch<CatalogListResponse>(`/api/v1/catalog?${qs}`),
    staleTime: 60_000,
  });
}

export function useCatalogEntry(id: string | undefined) {
  return useQuery({
    queryKey: ['catalog', id],
    queryFn: () => apiFetch<CatalogSingleResponse>(`/api/v1/catalog/${id}`),
    enabled: Boolean(id),
  });
}

interface UpdateBadgesInput {
  readonly id: string;
  readonly featured?: boolean;
  readonly popular?: boolean;
}

export function useUpdateCatalogBadges() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...body }: UpdateBadgesInput) =>
      apiFetch<{ data: CatalogEntry }>(`/api/v1/admin/catalog/${id}/badges`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['catalog'] });
    },
  });
}
