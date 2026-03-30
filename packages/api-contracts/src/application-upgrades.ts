import { z } from 'zod';
import { uuidField } from './shared.js';

// ─── Upgrade Status ──────────────────────────────────────────────────────────

export const upgradeStatusEnum = z.enum([
  'pending',
  'backing_up',
  'pre_check',
  'upgrading',
  'health_check',
  'rolling_back',
  'completed',
  'failed',
  'rolled_back',
]);

export const triggerTypeEnum = z.enum(['manual', 'batch', 'forced']);

// ─── Response Schemas ────────────────────────────────────────────────────────

export const applicationUpgradeResponseSchema = z.object({
  id: uuidField,
  instanceId: z.string(),
  fromVersion: z.string(),
  toVersion: z.string(),
  status: upgradeStatusEnum,
  triggeredBy: z.string(),
  triggerType: triggerTypeEnum,
  backupId: z.string().nullable(),
  progressPct: z.number(),
  statusMessage: z.string().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const availableUpgradeSchema = z.object({
  version: z.string(),
  isDefault: z.number(),
  breakingChanges: z.string().nullable(),
  migrationNotes: z.string().nullable(),
  envChanges: z.array(z.object({
    key: z.string(),
    action: z.enum(['add', 'remove', 'rename']),
    oldKey: z.string().optional(),
    default: z.unknown().optional(),
  })).nullable(),
  minResources: z.object({
    cpu: z.string().optional(),
    memory: z.string().optional(),
    storage: z.string().optional(),
  }).nullable(),
});

// ─── Input Schemas ───────────────────────────────────────────────────────────

export const triggerUpgradeSchema = z.object({
  toVersion: z.string().min(1).max(50),
});

export const batchUpgradeSchema = z.object({
  instanceIds: z.array(uuidField).min(1).max(50),
  toVersion: z.string().min(1).max(50),
});

// ─── Types ───────────────────────────────────────────────────────────────────

export type ApplicationUpgradeResponse = z.infer<typeof applicationUpgradeResponseSchema>;
export type AvailableUpgrade = z.infer<typeof availableUpgradeSchema>;
export type TriggerUpgradeInput = z.infer<typeof triggerUpgradeSchema>;
export type BatchUpgradeInput = z.infer<typeof batchUpgradeSchema>;
export type UpgradeStatus = z.infer<typeof upgradeStatusEnum>;
export type TriggerType = z.infer<typeof triggerTypeEnum>;
