import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type { Database } from '../../db/index.js';
import { aiProviders, aiModels, aiTokenUsage } from '../../db/schema.js';
import { createProviderAdapter, type LlmMessage, type LlmResponse } from './providers/index.js';
import { scanOutput } from './output-scanner.js';
import type { AiProviderType } from '@k8s-hosting/api-contracts';

// ─── Provider CRUD ─────────────────────────────────────────────────────────

export async function listProviders(db: Database) {
  return db.select().from(aiProviders).orderBy(aiProviders.displayName);
}

export async function getProvider(db: Database, id: string) {
  const [row] = await db.select().from(aiProviders).where(eq(aiProviders.id, id));
  return row ?? null;
}

export async function createProvider(
  db: Database,
  input: { id: string; type: string; displayName: string; baseUrl?: string | null; apiKey?: string },
) {
  const [row] = await db.insert(aiProviders).values({
    id: input.id,
    type: input.type,
    displayName: input.displayName,
    baseUrl: input.baseUrl ?? null,
    apiKeyEnc: input.apiKey ?? null,
  }).returning();
  return row;
}

export async function updateProvider(
  db: Database,
  id: string,
  input: { displayName?: string; baseUrl?: string | null; apiKey?: string; enabled?: boolean },
) {
  const updates: Record<string, unknown> = {};
  if (input.displayName !== undefined) updates.displayName = input.displayName;
  if (input.baseUrl !== undefined) updates.baseUrl = input.baseUrl;
  if (input.apiKey !== undefined) updates.apiKeyEnc = input.apiKey;
  if (input.enabled !== undefined) updates.enabled = input.enabled;

  if (Object.keys(updates).length === 0) return getProvider(db, id);

  const [row] = await db.update(aiProviders).set(updates).where(eq(aiProviders.id, id)).returning();
  return row ?? null;
}

export async function deleteProvider(db: Database, id: string) {
  await db.delete(aiProviders).where(eq(aiProviders.id, id));
}

// ─── Model CRUD ────────────────────────────────────────────────────────────

export async function listModels(db: Database) {
  return db.select().from(aiModels).orderBy(aiModels.displayName);
}

export async function getModel(db: Database, id: string) {
  const [row] = await db.select().from(aiModels).where(eq(aiModels.id, id));
  return row ?? null;
}

export async function createModel(
  db: Database,
  input: {
    id: string;
    providerId: string;
    modelName: string;
    displayName: string;
    costPer1mInputTokens?: number;
    costPer1mOutputTokens?: number;
    maxOutputTokens?: number;
  },
) {
  const [row] = await db.insert(aiModels).values({
    id: input.id,
    providerId: input.providerId,
    modelName: input.modelName,
    displayName: input.displayName,
    costPer1mInputTokens: String(input.costPer1mInputTokens ?? 0),
    costPer1mOutputTokens: String(input.costPer1mOutputTokens ?? 0),
    maxOutputTokens: input.maxOutputTokens ?? 4096,
  }).returning();
  return row;
}

export async function updateModel(
  db: Database,
  id: string,
  input: { displayName?: string; costPer1mInputTokens?: number; costPer1mOutputTokens?: number; maxOutputTokens?: number; enabled?: boolean },
) {
  const updates: Record<string, unknown> = {};
  if (input.displayName !== undefined) updates.displayName = input.displayName;
  if (input.costPer1mInputTokens !== undefined) updates.costPer1mInputTokens = String(input.costPer1mInputTokens);
  if (input.costPer1mOutputTokens !== undefined) updates.costPer1mOutputTokens = String(input.costPer1mOutputTokens);
  if (input.maxOutputTokens !== undefined) updates.maxOutputTokens = input.maxOutputTokens;
  if (input.enabled !== undefined) updates.enabled = input.enabled;

  if (Object.keys(updates).length === 0) return getModel(db, id);

  const [row] = await db.update(aiModels).set(updates).where(eq(aiModels.id, id)).returning();
  return row ?? null;
}

export async function deleteModel(db: Database, id: string) {
  await db.delete(aiModels).where(eq(aiModels.id, id));
}

// ─── Test Connection ───────────────────────────────────────────────────────

export async function testProviderConnection(db: Database, providerId: string, modelId?: string) {
  const provider = await getProvider(db, providerId);
  if (!provider) throw new Error('Provider not found');
  if (!provider.apiKeyEnc) throw new Error('No API key configured');

  const adapter = createProviderAdapter(
    provider.type as AiProviderType,
    provider.apiKeyEnc,
    provider.baseUrl,
  );

  let modelName: string | undefined;
  if (modelId) {
    const model = await getModel(db, modelId);
    if (model) modelName = model.modelName;
  }

  return adapter.testConnection(modelName);
}

// ─── AI Edit (file mode) ──────────────────────────────────────────────────

const FILE_SYSTEM_PROMPT = `You are a code editor assistant. Output ONLY the complete modified file content.
No explanation, no markdown fences, no commentary before or after the code.
If the request is unclear, make your best interpretation and apply it.`;

export interface FileEditInput {
  filePath: string;
  fileContent: string;
  instruction: string;
  modelId: string;
  clientId: string;
  deploymentId: string | null;
  isAdmin: boolean;
}

export interface EditChange {
  path: string;
  action: 'create' | 'modify' | 'delete';
  originalContent?: string;
  modifiedContent?: string;
  summary?: string;
}

export interface EditResult {
  changes: EditChange[];
  tokensUsed: { input: number; output: number };
}

export async function editFile(db: Database, input: FileEditInput): Promise<EditResult> {
  const model = await getModel(db, input.modelId);
  if (!model) throw new Error(`Model "${input.modelId}" not found`);

  const provider = await getProvider(db, model.providerId);
  if (!provider) throw new Error(`Provider "${model.providerId}" not found`);
  if (!provider.apiKeyEnc) throw new Error('No API key configured for provider');
  if (!provider.enabled) throw new Error('Provider is disabled');
  if (!model.enabled) throw new Error('Model is disabled');

  const adapter = createProviderAdapter(
    provider.type as AiProviderType,
    provider.apiKeyEnc,
    provider.baseUrl,
  );

  const messages: LlmMessage[] = [
    { role: 'system', content: FILE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `File: ${input.filePath}\n\nCurrent content:\n\`\`\`\n${input.fileContent}\n\`\`\`\n\nInstruction: ${input.instruction}`,
    },
  ];

  const response: LlmResponse = await adapter.call(
    model.modelName,
    messages,
    { maxTokens: model.maxOutputTokens },
  );

  let modifiedContent = response.content;

  // Strip markdown fences if the LLM wrapped the output
  modifiedContent = stripMarkdownFences(modifiedContent);

  // Run output scanner for non-admin edits
  if (!input.isAdmin) {
    const scanResult = scanOutput(modifiedContent);
    if (scanResult.refused) {
      return {
        changes: [{
          path: input.filePath,
          action: 'modify',
          summary: scanResult.refusalMessage ?? 'Request was refused by the AI.',
        }],
        tokensUsed: { input: response.tokensInput, output: response.tokensOutput },
      };
    }
    modifiedContent = scanResult.content;
  }

  // Log token usage
  await db.insert(aiTokenUsage).values({
    id: randomUUID(),
    clientId: input.clientId,
    deploymentId: input.deploymentId,
    modelId: input.modelId,
    mode: 'file',
    tokensInput: response.tokensInput,
    tokensOutput: response.tokensOutput,
    instruction: input.instruction.slice(0, 500),
  });

  return {
    changes: [{
      path: input.filePath,
      action: 'modify',
      originalContent: input.fileContent,
      modifiedContent,
    }],
    tokensUsed: { input: response.tokensInput, output: response.tokensOutput },
  };
}

// ─── AI Edit (folder mode — agentic) ──────────────────────────────────────

const FOLDER_PLAN_PROMPT = `You are a code editor assistant. The user wants to modify files in a directory.

Given the file listing below, determine which files you need to read and propose a plan.

Respond with ONLY a JSON object (no markdown fences):
{
  "filesToRead": ["file1.ext", "file2.ext"],
  "plan": "Brief description of what you will change in each file"
}`;

const FOLDER_APPLY_PROMPT = `You are a code editor assistant. Output ONLY the complete modified file content.
No explanation, no markdown fences, no commentary.`;

export interface FolderEditInput {
  folderPath: string;
  fileList: Array<{ name: string; size: number; type: string }>;
  instruction: string;
  modelId: string;
  clientId: string;
  deploymentId: string | null;
  isAdmin: boolean;
  readFile: (path: string) => Promise<string>;
}

export async function editFolder(db: Database, input: FolderEditInput): Promise<EditResult & { planSummary: string }> {
  const model = await getModel(db, input.modelId);
  if (!model) throw new Error(`Model "${input.modelId}" not found`);

  const provider = await getProvider(db, model.providerId);
  if (!provider?.apiKeyEnc || !provider.enabled || !model.enabled) {
    throw new Error('Provider or model not available');
  }

  const adapter = createProviderAdapter(
    provider.type as AiProviderType,
    provider.apiKeyEnc,
    provider.baseUrl,
  );

  // Step 1: Plan
  const fileListStr = input.fileList
    .map((f) => `${f.type === 'directory' ? '📁' : '📄'} ${f.name} (${f.size} bytes)`)
    .join('\n');

  const planResponse = await adapter.call(model.modelName, [
    { role: 'system', content: FOLDER_PLAN_PROMPT },
    { role: 'user', content: `Directory: ${input.folderPath}\n\nFiles:\n${fileListStr}\n\nInstruction: ${input.instruction}` },
  ], { maxTokens: 1024 });

  let plan: { filesToRead: string[]; plan: string };
  try {
    plan = JSON.parse(stripMarkdownFences(planResponse.content));
  } catch {
    throw new Error('AI returned an invalid plan. Please try rephrasing your instruction.');
  }

  let totalInput = planResponse.tokensInput;
  let totalOutput = planResponse.tokensOutput;

  // Step 2: Read files and apply changes
  const changes: EditChange[] = [];

  for (const fileName of plan.filesToRead) {
    const filePath = `${input.folderPath}/${fileName}`.replace(/\/\//g, '/');
    let originalContent: string;
    try {
      originalContent = await input.readFile(filePath);
    } catch {
      continue; // file doesn't exist or unreadable
    }

    const applyResponse = await adapter.call(model.modelName, [
      { role: 'system', content: FOLDER_APPLY_PROMPT },
      {
        role: 'user',
        content: `File: ${fileName}\nPlan: ${plan.plan}\nInstruction: ${input.instruction}\n\nCurrent content:\n\`\`\`\n${originalContent}\n\`\`\``,
      },
    ], { maxTokens: model.maxOutputTokens });

    totalInput += applyResponse.tokensInput;
    totalOutput += applyResponse.tokensOutput;

    let modifiedContent = stripMarkdownFences(applyResponse.content);

    if (!input.isAdmin) {
      const scanResult = scanOutput(modifiedContent);
      if (scanResult.refused) continue;
      modifiedContent = scanResult.content;
    }

    if (modifiedContent !== originalContent) {
      changes.push({
        path: filePath,
        action: 'modify',
        originalContent,
        modifiedContent,
      });
    }
  }

  // Log usage
  await db.insert(aiTokenUsage).values({
    id: randomUUID(),
    clientId: input.clientId,
    deploymentId: input.deploymentId,
    modelId: input.modelId,
    mode: 'folder',
    tokensInput: totalInput,
    tokensOutput: totalOutput,
    instruction: input.instruction.slice(0, 500),
  });

  return {
    changes,
    tokensUsed: { input: totalInput, output: totalOutput },
    planSummary: plan.plan,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function stripMarkdownFences(content: string): string {
  const trimmed = content.trim();
  // Match ```lang\n...\n``` or ```\n...\n```
  const fenceMatch = trimmed.match(/^```(?:\w+)?\s*\n([\s\S]*?)\n```\s*$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}
