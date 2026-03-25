import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

interface Client {
  readonly id: string;
  readonly companyName: string;
}

interface ClientsResponse {
  readonly data: readonly Client[];
}

/**
 * Returns the current client context for the client panel.
 * In Phase 1, this fetches the first client from the API.
 * In Phase 2, this will be derived from the logged-in user's client association.
 */
export function useClientContext() {
  const { data, isLoading } = useQuery({
    queryKey: ['client-context'],
    queryFn: () => apiFetch<ClientsResponse>('/api/v1/clients?limit=1'),
    staleTime: 300_000,
  });

  const client = data?.data?.[0] ?? null;

  return {
    clientId: client?.id ?? null,
    clientName: client?.companyName ?? null,
    isLoading,
  };
}
