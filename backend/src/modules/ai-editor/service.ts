import { eq, sql, and, gte } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type { Database } from '../../db/index.js';
import { aiProviders, aiModels, aiTokenUsage, clients } from '../../db/schema.js';
import { createProviderAdapter, type LlmMessage, type LlmResponse } from './providers/index.js';
import { scanOutput } from './output-scanner.js';
import type { AiProviderType } from '@k8s-hosting/api-contracts';

// ─── Token Budget ──────────────────────────────────────────────────────────

function getWeekStart(): Date {
  const now = new Date();
  const day = now.getUTCDay();
  const diff = day === 0 ? 6 : day - 1; // Monday = start of week
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - diff);
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}

export async function getTokenBudget(db: Database, clientId: string) {
  const weekStart = getWeekStart();

  // Get this week's token usage
  const usageRows = await db.select({
    totalInput: sql<number>`COALESCE(SUM(tokens_input), 0)`,
    totalOutput: sql<number>`COALESCE(SUM(tokens_output), 0)`,
  }).from(aiTokenUsage).where(
    and(eq(aiTokenUsage.clientId, clientId), gte(aiTokenUsage.createdAt, weekStart))
  );

  const tokensUsed = Number(usageRows[0]?.totalInput ?? 0) + Number(usageRows[0]?.totalOutput ?? 0);

  // Get budget limit from plan (via client → plan)
  const clientRows = await db.select().from(clients).where(eq(clients.id, clientId));
  const client = clientRows[0];
  // Default: $1/week = 100 cents
  const weeklyBudgetCents = 100; // TODO: read from hosting_plans via client.planId

  // Calculate token limit based on cheapest available model
  const models = await listModels(db);
  const cheapestCostPer1m = models.reduce((min, m) => {
    const cost = Number(m.costPer1mInputTokens ?? 0) + Number(m.costPer1mOutputTokens ?? 0);
    return cost > 0 && cost < min ? cost : min;
  }, Infinity);

  const budgetDollars = weeklyBudgetCents / 100;
  const tokenLimit = cheapestCostPer1m < Infinity
    ? Math.round((budgetDollars / cheapestCostPer1m) * 1_000_000)
    : 1_000_000; // fallback 1M if no pricing set

  const costUsed = models.length > 0
    ? (tokensUsed / 1_000_000) * (cheapestCostPer1m < Infinity ? cheapestCostPer1m : 1)
    : 0;

  return {
    tokensUsed,
    tokenLimit,
    budgetCents: weeklyBudgetCents,
    costUsedCents: Math.round(costUsed * 100),
    weekStart: weekStart.toISOString(),
    percentUsed: tokenLimit > 0 ? Math.round((tokensUsed / tokenLimit) * 100) : 0,
    exhausted: tokensUsed >= tokenLimit,
  };
}

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

Given the file listing below, plan all operations needed. Available operations:

- read: read an existing file to understand its content before modifying it
- create: generate a new file (you will provide the content in the next step)
- modify: change an existing file (you must read it first)
- delete: remove a file or empty directory
- rename: rename or move a file/directory (from → to)
- download: fetch a URL and save to a local path (for images, libraries, assets — efficient, no token cost)
- mkdir: create a directory

Respond with ONLY a JSON object (no markdown fences):
{
  "operations": [
    { "op": "read", "path": "existing-file.ext" },
    { "op": "modify", "path": "existing-file.ext" },
    { "op": "create", "path": "new-file.ext" },
    { "op": "download", "url": "https://example.com/image.jpg", "path": "images/photo.jpg" },
    { "op": "mkdir", "path": "images/gallery" },
    { "op": "delete", "path": "old-file.ext" },
    { "op": "rename", "from": "old-name.ext", "to": "new-name.ext" }
  ],
  "plan": "Brief description of what will happen"
}

Rules:
- A file you want to modify MUST have a "read" operation BEFORE the "modify" operation.
- Use "download" for binary files, images, CSS/JS libraries from CDNs — never generate binary content.
- Use "create" only for text files you generate (HTML, CSS, JS, PHP, config files).
- Paths are relative to the current directory.`;

const FOLDER_APPLY_PROMPT = `You are a code editor assistant. Output ONLY the complete modified file content.
No explanation, no markdown fences, no commentary.`;

const FOLDER_CREATE_PROMPT = `You are a code editor assistant. Create the requested file from scratch.
Output ONLY the complete file content. No explanation, no markdown fences, no commentary.`;

export type FolderOp =
  | { op: 'read'; path: string }
  | { op: 'create'; path: string }
  | { op: 'modify'; path: string }
  | { op: 'delete'; path: string }
  | { op: 'rename'; from: string; to: string }
  | { op: 'download'; url: string; path: string }
  | { op: 'mkdir'; path: string };

export interface FolderPlanInput {
  folderPath: string;
  fileList: Array<{ name: string; size: number; type: string }>;
  instruction: string;
  modelId: string;
}

export interface FolderPlanResult {
  operations: FolderOp[];
  plan: string;
  tokensUsed: { input: number; output: number };
  // Derived convenience lists
  filesToRead: string[];
  filesToCreate: string[];
}

export interface FolderExecuteInput {
  folderPath: string;
  operations: FolderOp[];
  plan: string;
  instruction: string;
  modelId: string;
  clientId: string;
  deploymentId: string | null;
  isAdmin: boolean;
  readFile: (path: string) => Promise<string>;
}

// Keep the combined interface for backward compat
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

export async function planFolderEdit(db: Database, input: FolderPlanInput): Promise<FolderPlanResult> {
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

  const fileListStr = input.fileList
    .map((f) => `${f.type === 'directory' ? '📁' : '📄'} ${f.name} (${f.size} bytes)`)
    .join('\n');

  const planResponse = await adapter.call(model.modelName, [
    { role: 'system', content: FOLDER_PLAN_PROMPT },
    { role: 'user', content: `Directory: ${input.folderPath}\n\nFiles:\n${fileListStr}\n\nInstruction: ${input.instruction}` },
  ], { maxTokens: 1024 });

  let parsed: { operations?: FolderOp[]; plan: string; filesToRead?: string[]; filesToCreate?: string[] };
  try {
    const cleaned = extractJson(planResponse.content);
    parsed = JSON.parse(cleaned);
  } catch {
    // Return a helpful error with what the AI actually said
    const preview = planResponse.content.slice(0, 200);
    throw new Error(`AI didn't return a valid JSON plan. Response preview: "${preview}..." — try rephrasing your instruction.`);
  }

  // Support both new (operations array) and legacy (filesToRead/filesToCreate) formats
  const operations: FolderOp[] = parsed.operations ?? [
    ...(parsed.filesToRead ?? []).map((p): FolderOp => ({ op: 'read', path: p })),
    ...(parsed.filesToRead ?? []).map((p): FolderOp => ({ op: 'modify', path: p })),
    ...(parsed.filesToCreate ?? []).map((p): FolderOp => ({ op: 'create', path: p })),
  ];

  return {
    operations,
    plan: parsed.plan,
    tokensUsed: { input: planResponse.tokensInput, output: planResponse.tokensOutput },
    filesToRead: operations.filter((o) => o.op === 'read').map((o) => (o as { path: string }).path),
    filesToCreate: operations.filter((o) => o.op === 'create').map((o) => (o as { path: string }).path),
  };
}

export async function executeFolderEdit(db: Database, input: FolderExecuteInput): Promise<EditResult> {
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

  let totalInput = 0;
  let totalOutput = 0;
  const changes: EditChange[] = [];
  const readCache = new Map<string, string>();

  for (const op of input.operations) {
    const resolvePath = (p: string) => `${input.folderPath}/${p}`.replace(/\/\//g, '/');

    switch (op.op) {
      case 'read': {
        const filePath = resolvePath(op.path);
        try {
          const content = await input.readFile(filePath);
          readCache.set(op.path, content);
        } catch { /* file not readable — skip */ }
        break;
      }

      case 'modify': {
        const filePath = resolvePath(op.path);
        const originalContent = readCache.get(op.path);
        if (originalContent === undefined) break; // wasn't read

        const applyResponse = await adapter.call(model.modelName, [
          { role: 'system', content: FOLDER_APPLY_PROMPT },
          {
            role: 'user',
            content: `File: ${op.path}\nPlan: ${input.plan}\nInstruction: ${input.instruction}\n\nCurrent content:\n\`\`\`\n${originalContent}\n\`\`\``,
          },
        ], { maxTokens: model.maxOutputTokens });

        totalInput += applyResponse.tokensInput;
        totalOutput += applyResponse.tokensOutput;

        let modifiedContent = stripMarkdownFences(applyResponse.content);
        if (!input.isAdmin) {
          const scanResult = scanOutput(modifiedContent);
          if (scanResult.refused) break;
          modifiedContent = scanResult.content;
        }

        if (modifiedContent !== originalContent) {
          changes.push({ path: filePath, action: 'modify', originalContent, modifiedContent });
        }
        break;
      }

      case 'create': {
        const filePath = resolvePath(op.path);
        const createResponse = await adapter.call(model.modelName, [
          { role: 'system', content: FOLDER_CREATE_PROMPT },
          { role: 'user', content: `Create new file: ${op.path}\nPlan: ${input.plan}\nInstruction: ${input.instruction}` },
        ], { maxTokens: model.maxOutputTokens });

        totalInput += createResponse.tokensInput;
        totalOutput += createResponse.tokensOutput;

        let newContent = stripMarkdownFences(createResponse.content);
        if (!input.isAdmin) {
          const scanResult = scanOutput(newContent);
          if (scanResult.refused) break;
          newContent = scanResult.content;
        }

        if (newContent.trim()) {
          changes.push({ path: filePath, action: 'create', modifiedContent: newContent });
        }
        break;
      }

      case 'delete': {
        const filePath = resolvePath(op.path);
        changes.push({ path: filePath, action: 'delete' });
        break;
      }

      case 'rename': {
        const fromPath = resolvePath(op.from);
        const toPath = resolvePath(op.to);
        changes.push({ path: fromPath, action: 'modify', summary: `Rename → ${toPath}`, modifiedContent: toPath });
        break;
      }

      case 'download': {
        const filePath = resolvePath(op.path);
        changes.push({ path: filePath, action: 'create', summary: `Download from ${op.url}`, modifiedContent: `__DOWNLOAD__:${op.url}` });
        break;
      }

      case 'mkdir': {
        const filePath = resolvePath(op.path);
        changes.push({ path: filePath, action: 'create', summary: 'Create directory' });
        break;
      }
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

  return { changes, tokensUsed: { input: totalInput, output: totalOutput } };
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
    plan = JSON.parse(extractJson(planResponse.content));
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
  const fenceMatch = trimmed.match(/^```(?:\w+)?\s*\n([\s\S]*?)\n```\s*$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}

/** Extract JSON from LLM output that may contain markdown fences, prose, or mixed content. */
function extractJson(content: string): string {
  const trimmed = content.trim();

  // Try direct parse first
  try { JSON.parse(trimmed); return trimmed; } catch { /* continue */ }

  // Try stripping markdown fences
  const stripped = stripMarkdownFences(trimmed);
  try { JSON.parse(stripped); return stripped; } catch { /* continue */ }

  // Find first { and last } — extract the JSON object
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    try { JSON.parse(candidate); return candidate; } catch { /* continue */ }
  }

  // Last resort — return stripped version (will fail at caller)
  return stripped;
}
