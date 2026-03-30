import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ProvisioningStep {
  readonly name: string;
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly error?: string | null;
}

interface ProvisioningTask {
  readonly id: string;
  readonly clientId: string;
  readonly type: string;
  readonly status: 'pending' | 'running' | 'completed' | 'failed';
  readonly currentStep: string | null;
  readonly totalSteps: number;
  readonly completedSteps: number;
  readonly stepsLog: readonly ProvisioningStep[] | null;
  readonly errorMessage: string | null;
  readonly startedBy: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ActiveTask {
  readonly id: string;
  readonly clientId: string;
  readonly companyName: string;
  readonly type: string;
  readonly status: 'pending' | 'running' | 'completed' | 'failed';
  readonly currentStep: string | null;
  readonly completedSteps: number;
  readonly totalSteps: number;
}

interface ActiveTasksSummary {
  readonly count: number;
  readonly tasks: readonly ActiveTask[];
}

interface TriggerResponse {
  readonly taskId: string;
  readonly clientId: string;
  readonly status: string;
  readonly totalSteps: number;
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

/** Poll active provisioning tasks for the header indicator */
export function useActiveTasks() {
  return useQuery({
    queryKey: ['provisioning-active-tasks'],
    queryFn: () => apiFetch<{ data: ActiveTasksSummary }>('/api/v1/admin/provisioning/tasks'),
    refetchInterval: 3_000, // Poll every 3s while tasks are active
    select: (res) => res.data,
  });
}

/** Get provisioning status for a specific client */
export function useProvisioningStatus(clientId: string, enabled = true) {
  return useQuery({
    queryKey: ['provisioning-status', clientId],
    queryFn: () => apiFetch<{ data: ProvisioningTask }>(`/api/v1/admin/clients/${clientId}/provision/status`),
    refetchInterval: 2_000, // Poll every 2s during provisioning
    enabled,
    select: (res) => res.data,
    retry: false, // Don't retry 404s
  });
}

/** Trigger namespace provisioning */
export function useTriggerProvisioning() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clientId, overrides }: { clientId: string; overrides?: Record<string, string> }) =>
      apiFetch<{ data: TriggerResponse }>(`/api/v1/admin/clients/${clientId}/provision`, {
        method: 'POST',
        body: JSON.stringify({ overrides }),
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['provisioning-active-tasks'] });
      qc.invalidateQueries({ queryKey: ['provisioning-status', vars.clientId] });
      qc.invalidateQueries({ queryKey: ['clients'] });
    },
  });
}

/** Trigger decommission (delete K8s namespace) */
export function useTriggerDecommission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (clientId: string) =>
      apiFetch<{ data: TriggerResponse }>(`/api/v1/admin/clients/${clientId}/decommission`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: (_data, clientId) => {
      qc.invalidateQueries({ queryKey: ['provisioning-active-tasks'] });
      qc.invalidateQueries({ queryKey: ['provisioning-status', clientId] });
      qc.invalidateQueries({ queryKey: ['clients'] });
    },
  });
}

export type { ProvisioningTask, ProvisioningStep, ActiveTask, ActiveTasksSummary };
