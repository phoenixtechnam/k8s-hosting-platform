import { z } from 'zod';
import { uuidField, paginatedResponseSchema } from './shared.js';

// ─── Provisioning Task Types ─────────────────────────────────────────────────

export const provisioningTaskTypeEnum = z.enum([
  'provision_namespace',
  'deploy_workload',
  'deprovision',
]);

export const provisioningTaskStatusEnum = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
]);

export const provisioningStatusEnum = z.enum([
  'unprovisioned',
  'provisioning',
  'provisioned',
  'failed',
]);

// ─── Input Schemas ───────────────────────────────────────────────────────────

export const triggerProvisionSchema = z.object({
  /** Optional: override resource limits for this provisioning run */
  overrides: z.object({
    cpu_limit: z.string().optional(),
    memory_limit: z.string().optional(),
    storage_limit: z.string().optional(),
  }).optional(),
});

export type TriggerProvisionInput = z.infer<typeof triggerProvisionSchema>;

// ─── Step Log Entry ──────────────────────────────────────────────────────────

export const provisioningStepSchema = z.object({
  name: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'skipped']),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  error: z.string().nullable().optional(),
});

export type ProvisioningStep = z.infer<typeof provisioningStepSchema>;

// ─── Response Schemas ────────────────────────────────────────────────────────

export const provisioningTaskResponseSchema = z.object({
  id: uuidField,
  clientId: uuidField,
  type: provisioningTaskTypeEnum,
  status: provisioningTaskStatusEnum,
  currentStep: z.string().nullable(),
  totalSteps: z.number(),
  completedSteps: z.number(),
  stepsLog: z.array(provisioningStepSchema).nullable(),
  errorMessage: z.string().nullable(),
  startedBy: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ProvisioningTaskResponse = z.infer<typeof provisioningTaskResponseSchema>;

export const provisioningTaskListResponseSchema = paginatedResponseSchema(provisioningTaskResponseSchema);

export type ProvisioningTaskListResponse = z.infer<typeof provisioningTaskListResponseSchema>;

// ─── Active Tasks Summary (for header indicator) ─────────────────────────────

export const activeTasksSummarySchema = z.object({
  count: z.number(),
  tasks: z.array(z.object({
    id: uuidField,
    clientId: uuidField,
    companyName: z.string(),
    type: provisioningTaskTypeEnum,
    status: provisioningTaskStatusEnum,
    currentStep: z.string().nullable(),
    completedSteps: z.number(),
    totalSteps: z.number(),
  })),
});

export type ActiveTasksSummary = z.infer<typeof activeTasksSummarySchema>;
