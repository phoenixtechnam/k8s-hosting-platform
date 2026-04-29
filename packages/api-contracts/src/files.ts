import { z } from 'zod';

// ─── File Entry ──────────────────────────────────────────────────────────────

export const fileEntrySchema = z.object({
  name: z.string(),
  type: z.enum(['file', 'directory']),
  size: z.number(),
  modifiedAt: z.string().nullable(),
  permissions: z.string(),
  uid: z.number(),
  gid: z.number(),
  owner: z.string().optional(),
  group: z.string().optional(),
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

// ─── Copy ───────────────────────────────────────────────────────────────────

export const copyInputSchema = z.object({
  sourcePath: z.string().min(1),
  destPath: z.string().min(1),
});

export type CopyInput = z.infer<typeof copyInputSchema>;

// ─── Archive ────────────────────────────────────────────────────────────────

export const archiveInputSchema = z.object({
  paths: z.array(z.string().min(1)).min(1),
  destPath: z.string().min(1),
  format: z.enum(['zip', 'tar.gz', 'tar']).default('tar.gz'),
});

export type ArchiveInput = z.infer<typeof archiveInputSchema>;

// ─── Extract ────────────────────────────────────────────────────────────────

export const extractInputSchema = z.object({
  path: z.string().min(1),
  destPath: z.string().min(1).default('/'),
});

export type ExtractInput = z.infer<typeof extractInputSchema>;

// ─── Git Clone ──────────────────────────────────────────────────────────────

export const gitCloneInputSchema = z.object({
  url: z.string().url(),
  destPath: z.string().min(1),
});

export type GitCloneInput = z.infer<typeof gitCloneInputSchema>;

// ─── Chmod / Chown ──────────────────────────────────────────────────────────

export const chmodInputSchema = z.object({
  path: z.string().min(1),
  mode: z.string().regex(/^[0-7]{3,4}$/, 'mode must be an octal string (e.g. "755")'),
  recursive: z.boolean().optional(),
});

export type ChmodInput = z.infer<typeof chmodInputSchema>;

export const chownInputSchema = z.object({
  path: z.string().min(1),
  uid: z.number().int().min(0).optional(),
  gid: z.number().int().min(0).optional(),
  owner: z.string().max(32).optional(),
  group: z.string().max(32).optional(),
  recursive: z.boolean().optional(),
}).refine(data => data.uid !== undefined || data.gid !== undefined || data.owner !== undefined || data.group !== undefined, {
  message: 'At least one of uid/owner or gid/group must be provided',
});

export type ChownInput = z.infer<typeof chownInputSchema>;

// ─── File Manager Status ─────────────────────────────────────────────────────

export const fileManagerStatusSchema = z.object({
  ready: z.boolean(),
  phase: z.enum(['not_deployed', 'starting', 'ready', 'failed', 'stopping']),
  message: z.string().optional(),
});

export type FileManagerStatus = z.infer<typeof fileManagerStatusSchema>;
