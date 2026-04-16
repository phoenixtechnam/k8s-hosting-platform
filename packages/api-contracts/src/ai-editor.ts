import { z } from 'zod';

// ─── Provider types ────────────────────────────────────────────────────────

export const aiProviderTypeEnum = z.enum(['anthropic', 'openai', 'openai_compatible']);
export type AiProviderType = z.infer<typeof aiProviderTypeEnum>;

export const createAiProviderSchema = z.object({
  id: z.string().min(1).max(100).regex(/^[a-z0-9_-]+$/, 'Lowercase alphanumeric, hyphens, underscores only'),
  type: aiProviderTypeEnum,
  display_name: z.string().min(1).max(200),
  base_url: z.string().url().max(500).nullable().optional(),
  api_key: z.string().min(1).max(500).optional(),
});

export const updateAiProviderSchema = z.object({
  display_name: z.string().min(1).max(200).optional(),
  base_url: z.string().url().max(500).nullable().optional(),
  api_key: z.string().min(1).max(500).optional(),
  enabled: z.boolean().optional(),
});

export const aiProviderResponseSchema = z.object({
  id: z.string(),
  type: aiProviderTypeEnum,
  displayName: z.string(),
  baseUrl: z.string().nullable(),
  apiKeySet: z.boolean(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type AiProviderResponse = z.infer<typeof aiProviderResponseSchema>;

// ─── Model types ───────────────────────────────────────────────────────────

export const createAiModelSchema = z.object({
  id: z.string().min(1).max(100).regex(/^[a-z0-9_-]+$/, 'Lowercase alphanumeric, hyphens, underscores only'),
  provider_id: z.string().min(1).max(100),
  model_name: z.string().min(1).max(200),
  display_name: z.string().min(1).max(200),
  cost_per_1m_input_tokens: z.number().min(0).default(0),
  cost_per_1m_output_tokens: z.number().min(0).default(0),
  max_output_tokens: z.number().int().min(256).max(65536).default(4096),
});

export const updateAiModelSchema = z.object({
  display_name: z.string().min(1).max(200).optional(),
  cost_per_1m_input_tokens: z.number().min(0).optional(),
  cost_per_1m_output_tokens: z.number().min(0).optional(),
  max_output_tokens: z.number().int().min(256).max(65536).optional(),
  enabled: z.boolean().optional(),
});

export const aiModelResponseSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  modelName: z.string(),
  displayName: z.string(),
  costPer1mInputTokens: z.number(),
  costPer1mOutputTokens: z.number(),
  maxOutputTokens: z.number(),
  enabled: z.boolean(),
  createdAt: z.string(),
});

export type AiModelResponse = z.infer<typeof aiModelResponseSchema>;

// ─── AI Edit request/response ──────────────────────────────────────────────

export const aiEditModeEnum = z.enum(['file', 'folder', 'folder-plan', 'folder-execute', 'website']);
export type AiEditMode = z.infer<typeof aiEditModeEnum>;

export const aiEditRequestSchema = z.object({
  mode: aiEditModeEnum,
  deployment_id: z.string().min(1).optional(),
  instruction: z.string().min(1).max(5000),
  model_id: z.string().min(1).max(100).optional(),

  // mode: 'file'
  file_path: z.string().max(500).optional(),
  file_content: z.string().optional(),

  // mode: 'folder'
  folder_path: z.string().max(500).optional(),

  // mode: 'website' (Phase 4+)
  page_name: z.string().max(200).optional(),
});

export type AiEditRequest = z.infer<typeof aiEditRequestSchema>;

export const aiEditChangeSchema = z.object({
  path: z.string(),
  action: z.enum(['create', 'modify', 'delete']),
  originalContent: z.string().optional(),
  modifiedContent: z.string().optional(),
  summary: z.string().optional(),
});

export const aiEditResponseSchema = z.object({
  changes: z.array(aiEditChangeSchema),
  tokensUsed: z.object({ input: z.number(), output: z.number() }),
  budgetRemaining: z.number().optional(),
  planSummary: z.string().optional(),
});

export type AiEditResponse = z.infer<typeof aiEditResponseSchema>;

// ─── Folder plan response ──────────────────────────────────────────────────

export const aiFolderPlanResponseSchema = z.object({
  filesToRead: z.array(z.string()),
  filesToCreate: z.array(z.string()),
  plan: z.string(),
  tokensUsed: z.object({ input: z.number(), output: z.number() }),
});

export type AiFolderPlanResponse = z.infer<typeof aiFolderPlanResponseSchema>;

// ─── Test connection ───────────────────────────────────────────────────────

export const aiTestConnectionSchema = z.object({
  provider_id: z.string().min(1),
  model_id: z.string().min(1).optional(),
});

export const aiTestConnectionResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  latencyMs: z.number().optional(),
});
