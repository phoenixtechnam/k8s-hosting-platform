import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

interface CreatePlanInput {
  readonly code: string;
  readonly name: string;
  readonly description?: string;
  readonly cpu_limit: string;
  readonly memory_limit: string;
  readonly storage_limit: string;
  readonly monthly_price_usd: string;
  readonly max_sub_users?: number;
  readonly features?: Record<string, unknown>;
}

export function useCreatePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePlanInput) =>
      apiFetch<{ data: unknown }>('/api/v1/admin/plans', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['plans'] }); },
  });
}

export function useUpdatePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: Partial<CreatePlanInput> & { id: string; status?: string }) =>
      apiFetch<{ data: unknown }>(`/api/v1/admin/plans/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['plans'] }); },
  });
}

export function useDeletePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/admin/plans/${id}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['plans'] }); },
  });
}
