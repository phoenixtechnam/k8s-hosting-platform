import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  CreatePrivateWorkerInput,
  PrivateWorkerResponse,
  PrivateWorkerSecretResponse,
  PrivateWorkerListResponse,
  PrivateWorkerAuditListResponse,
} from '@k8s-hosting/api-contracts';

// All envelopes follow the platform `{ data, error }` convention. The
// list / audit endpoints already return their own `{ items: [...] }`
// shape inside `data`, mirroring how the backend service layer wraps
// arrays elsewhere.

interface PrivateWorkerListEnvelope {
  readonly data: PrivateWorkerListResponse;
}

interface PrivateWorkerEnvelope {
  readonly data: PrivateWorkerResponse;
}

interface PrivateWorkerSecretEnvelope {
  readonly data: PrivateWorkerSecretResponse;
}

interface PrivateWorkerAuditEnvelope {
  readonly data: PrivateWorkerAuditListResponse;
}

export function usePrivateWorkers(clientId: string | undefined) {
  return useQuery({
    queryKey: ['private-workers', clientId],
    queryFn: () =>
      apiFetch<PrivateWorkerListEnvelope>(
        `/api/v1/clients/${clientId}/private-workers`,
      ),
    enabled: Boolean(clientId),
  });
}

export function usePrivateWorker(
  clientId: string | undefined,
  workerId: string | undefined,
) {
  return useQuery({
    queryKey: ['private-workers', clientId, workerId],
    queryFn: () =>
      apiFetch<PrivateWorkerEnvelope>(
        `/api/v1/clients/${clientId}/private-workers/${workerId}`,
      ),
    enabled: Boolean(clientId) && Boolean(workerId),
  });
}

export function usePrivateWorkerAudit(
  clientId: string | undefined,
  workerId: string | undefined,
  limit = 50,
) {
  return useQuery({
    queryKey: ['private-workers', clientId, workerId, 'audit', limit],
    queryFn: () =>
      apiFetch<PrivateWorkerAuditEnvelope>(
        `/api/v1/clients/${clientId}/private-workers/${workerId}/audit?limit=${limit}`,
      ),
    enabled: Boolean(clientId) && Boolean(workerId),
  });
}

export function useCreatePrivateWorker(clientId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePrivateWorkerInput) =>
      apiFetch<PrivateWorkerSecretEnvelope>(
        `/api/v1/clients/${clientId}/private-workers`,
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['private-workers', clientId] });
    },
  });
}

export function useRotatePrivateWorker(clientId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workerId: string) =>
      apiFetch<PrivateWorkerSecretEnvelope>(
        `/api/v1/clients/${clientId}/private-workers/${workerId}/rotate`,
        {
          method: 'POST',
          body: JSON.stringify({}),
        },
      ),
    onSuccess: (_data, workerId) => {
      qc.invalidateQueries({ queryKey: ['private-workers', clientId] });
      qc.invalidateQueries({ queryKey: ['private-workers', clientId, workerId] });
    },
  });
}

export function useRevokePrivateWorker(clientId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workerId: string) =>
      apiFetch<PrivateWorkerEnvelope>(
        `/api/v1/clients/${clientId}/private-workers/${workerId}/revoke`,
        {
          method: 'POST',
          body: JSON.stringify({}),
        },
      ),
    onSuccess: (_data, workerId) => {
      qc.invalidateQueries({ queryKey: ['private-workers', clientId] });
      qc.invalidateQueries({ queryKey: ['private-workers', clientId, workerId] });
    },
  });
}

export function useDeletePrivateWorker(clientId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workerId: string) =>
      apiFetch<void>(
        `/api/v1/clients/${clientId}/private-workers/${workerId}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['private-workers', clientId] });
    },
  });
}
