import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { Client, PaginatedResponse } from '@/types/api';

interface ListClientsParams {
  readonly search?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export function useClients(params: ListClientsParams = {}) {
  const searchParams = new URLSearchParams();
  if (params.search) searchParams.set('search', params.search);
  if (params.limit) searchParams.set('limit', String(params.limit));
  if (params.cursor) searchParams.set('cursor', params.cursor);

  const qs = searchParams.toString();
  const path = `/api/v1/clients${qs ? `?${qs}` : ''}`;

  return useQuery({
    queryKey: ['clients', params],
    queryFn: () => apiFetch<PaginatedResponse<Client>>(path),
  });
}

export function useClient(id: string | undefined) {
  return useQuery({
    queryKey: ['clients', id],
    queryFn: () => apiFetch<{ data: Client }>(`/api/v1/clients/${id}`),
    enabled: !!id,
  });
}

interface CreateClientInput {
  readonly company_name: string;
  readonly company_email: string;
  readonly contact_email?: string;
  readonly plan_id: string;
  readonly region_id: string;
}

export function useCreateClient() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateClientInput) =>
      apiFetch<{ data: Client }>('/api/v1/clients', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
    },
  });
}

interface UpdateClientInput {
  readonly company_name?: string;
  readonly company_email?: string;
  readonly contact_email?: string;
  readonly status?: 'active' | 'suspended' | 'pending' | 'cancelled';
  readonly subscription_expires_at?: string;
  readonly cpu_limit_override?: number | null;
  readonly memory_limit_override?: number | null;
  readonly storage_limit_override?: number | null;
  readonly max_sub_users_override?: number | null;
  readonly monthly_price_override?: number | null;
}

export function useUpdateClient(id: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateClientInput) =>
      apiFetch<{ data: Client }>(`/api/v1/clients/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      queryClient.invalidateQueries({ queryKey: ['clients', id] });
    },
  });
}

export function useDeleteClient() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/clients/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
    },
  });
}
