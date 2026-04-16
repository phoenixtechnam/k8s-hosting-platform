import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { AiProviderResponse, AiModelResponse } from '@k8s-hosting/api-contracts';

// ─── Providers ─────────────────────────────────────────────────────────────

export function useAiProviders() {
  return useQuery({
    queryKey: ['ai-providers'],
    queryFn: () => apiFetch<{ data: AiProviderResponse[] }>('/api/v1/admin/ai/providers'),
  });
}

export function useCreateAiProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      id: string;
      type: string;
      display_name: string;
      base_url?: string | null;
      api_key?: string;
    }) => apiFetch<{ data: AiProviderResponse }>('/api/v1/admin/ai/providers', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ai-providers'] }),
  });
}

export function useUpdateAiProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: {
      id: string;
      display_name?: string;
      base_url?: string | null;
      api_key?: string;
      enabled?: boolean;
    }) => apiFetch<{ data: AiProviderResponse }>(`/api/v1/admin/ai/providers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ai-providers'] }),
  });
}

export function useDeleteAiProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/api/v1/admin/ai/providers/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ai-providers'] });
      qc.invalidateQueries({ queryKey: ['ai-models'] });
    },
  });
}

// ─── Models ────────────────────────────────────────────────────────────────

export function useAiModels() {
  return useQuery({
    queryKey: ['ai-models'],
    queryFn: () => apiFetch<{ data: AiModelResponse[] }>('/api/v1/admin/ai/models'),
  });
}

export function useCreateAiModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      id: string;
      provider_id: string;
      model_name: string;
      display_name: string;
      cost_per_1m_input_tokens?: number;
      cost_per_1m_output_tokens?: number;
      max_output_tokens?: number;
      admin_only?: boolean;
      is_default?: boolean;
    }) => apiFetch<{ data: AiModelResponse }>('/api/v1/admin/ai/models', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ai-models'] }),
  });
}

export function useUpdateAiModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: {
      id: string;
      display_name?: string;
      cost_per_1m_input_tokens?: number;
      cost_per_1m_output_tokens?: number;
      max_output_tokens?: number;
      enabled?: boolean;
      admin_only?: boolean;
      is_default?: boolean;
    }) => apiFetch<{ data: AiModelResponse }>(`/api/v1/admin/ai/models/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ai-models'] }),
  });
}

export function useDeleteAiModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/api/v1/admin/ai/models/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ai-models'] }),
  });
}

// ─── Test Connection ───────────────────────────────────────────────────────

export function useTestAiConnection() {
  return useMutation({
    mutationFn: (data: { provider_id: string; model_id?: string }) =>
      apiFetch<{ data: { success: boolean; message: string; latencyMs?: number } }>('/api/v1/admin/ai/test-connection', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  });
}
