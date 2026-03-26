import { z } from 'zod';

// ─── Response Schemas ────────────────────────────────────────────────────────

export const dashboardResponseSchema = z.object({
  total_clients: z.number(),
  active_clients: z.number(),
  total_domains: z.number(),
  total_databases: z.number(),
  total_backups: z.number(),
  platform_version: z.string(),
});

// ─── Types ───────────────────────────────────────────────────────────────────

export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;
