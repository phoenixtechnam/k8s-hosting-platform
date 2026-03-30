import { z } from 'zod';

// ─── File Entry ──────────────────────────────────────────────────────────────

export const fileEntrySchema = z.object({
  name: z.string(),
  type: z.enum(['file', 'directory']),
  size: z.number(),
  modifiedAt: z.string().nullable(),
  permissions: z.string(),
});

export type FileEntry = z.infer<typeof fileEntrySchema>;

// ─── List Directory ──────────────────────────────────────────────────────────

export const listDirectoryResponseSchema = z.object({
  path: z.string(),
  entries: z.array(fileEntrySchema),
});

export type ListDirectoryResponse = z.infer<typeof listDirectoryResponseSchema>;

// ─── Read File ───────────────────────────────────────────────────────────────

export const fileContentResponseSchema = z.object({
  path: z.string(),
  content: z.string(),
  size: z.number(),
  modifiedAt: z.string(),
});

export type FileContentResponse = z.infer<typeof fileContentResponseSchema>;

// ─── Write File ──────────────────────────────────────────────────────────────

export const writeFileInputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export type WriteFileInput = z.infer<typeof writeFileInputSchema>;

// ─── Create Directory ────────────────────────────────────────────────────────

export const createDirectoryInputSchema = z.object({
  path: z.string().min(1),
});

export type CreateDirectoryInput = z.infer<typeof createDirectoryInputSchema>;

// ─── Rename / Move ───────────────────────────────────────────────────────────

export const renameInputSchema = z.object({
  oldPath: z.string().min(1),
  newPath: z.string().min(1),
});

export type RenameInput = z.infer<typeof renameInputSchema>;

// ─── Delete ──────────────────────────────────────────────────────────────────

export const deleteInputSchema = z.object({
  path: z.string().min(1),
});

export type DeleteInput = z.infer<typeof deleteInputSchema>;

// ─── File Manager Status ─────────────────────────────────────────────────────

export const fileManagerStatusSchema = z.object({
  ready: z.boolean(),
  phase: z.enum(['not_deployed', 'starting', 'ready', 'failed']),
  message: z.string().optional(),
});

export type FileManagerStatus = z.infer<typeof fileManagerStatusSchema>;
