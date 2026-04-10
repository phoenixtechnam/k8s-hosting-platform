/**
 * Phase 3 T2.1 — IMAPSync job runner contracts.
 *
 * Triggered by an admin to migrate mail from an external IMAP
 * server (Gmail, Outlook, legacy hosting) into a platform mailbox.
 * The platform spawns a one-shot Kubernetes Job running the
 * imapsync image; status + log tail are tracked server-side.
 */

import { z } from 'zod';

export const imapSyncOptionsSchema = z
  .object({
    /** Pass `--automap` to imapsync to auto-create destination folders. */
    automap: z.boolean().optional(),
    /** Pass `--nofoldersizes` for faster startup on huge mailboxes. */
    noFolderSizes: z.boolean().optional(),
    /** Pass `--dry` for a no-op verify run. */
    dryRun: z.boolean().optional(),
    /** Patterns to exclude (folder names). */
    excludeFolders: z.array(z.string().min(1).max(255)).max(50).optional(),
  })
  .strict()
  .default({});

export const createImapSyncJobSchema = z
  .object({
    mailbox_id: z.string().uuid(),
    source_host: z.string().min(1).max(255),
    source_port: z.number().int().min(1).max(65535).default(993),
    source_username: z.string().min(1).max(255),
    source_password: z.string().min(1).max(1024),
    source_ssl: z.boolean().default(true),
    options: imapSyncOptionsSchema,
  })
  .strict();

export type CreateImapSyncJobInput = z.infer<typeof createImapSyncJobSchema>;

// Status returned to the API. Includes everything except the
// password (encrypted or otherwise) — that field never leaves the
// server.
export const imapSyncJobStatusSchema = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);

export type ImapSyncJobStatus = z.infer<typeof imapSyncJobStatusSchema>;

export interface ImapSyncJobResponse {
  readonly id: string;
  readonly clientId: string;
  readonly mailboxId: string;
  readonly sourceHost: string;
  readonly sourcePort: number;
  readonly sourceUsername: string;
  readonly sourceSsl: boolean;
  readonly options: Record<string, unknown>;
  readonly status: ImapSyncJobStatus;
  readonly k8sJobName: string | null;
  readonly k8sNamespace: string;
  readonly logTail: string | null;
  readonly errorMessage: string | null;
  // Round-4 Phase 3: progress tracking columns. Populated by the
  // reconciler from imapsync stdout while the job is running.
  // All four are nullable — they remain null until the reconciler
  // sees its first log fetch with a parseable progress line.
  readonly messagesTotal: number | null;
  readonly messagesTransferred: number | null;
  readonly currentFolder: string | null;
  readonly lastProgressAt: string | null;
  // IMAP Phase 3: pod-level observability. `podPhase` mirrors the
  // Kubernetes Pod phase (Pending | Running | Succeeded | Failed)
  // and `podMessage` is the human-readable reason when the pod is
  // stuck (e.g. `0/1 nodes are available: 1 Too many pods`). The
  // UI surfaces a warning banner on running jobs whose pod is not
  // actually running.
  readonly podPhase: string | null;
  readonly podMessage: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
