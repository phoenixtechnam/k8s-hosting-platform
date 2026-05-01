/**
 * Platform-level system settings exposed by GET /admin/system-settings
 * and PATCH'd via the same endpoint. The full row lives in
 * `system_settings` (Postgres, single row, id='system'). This module
 * declares the on-the-wire shape so backend and frontend stay in sync.
 *
 * Keep field names camelCase to match the backend's Drizzle convention
 * (the response renders the row as-is).
 */

import { z } from 'zod';

// ─── Update Schema ─────────────────────────────────────────────────────────
//
// Mirrors the Zod schema in backend/src/modules/system-settings/routes.ts.
// All fields are optional so PATCH can ship a partial update; the server
// preserves existing values for omitted keys.

export const updateSystemSettingsSchema = z.object({
  platformName: z.string().min(1).max(255).optional(),
  adminPanelUrl: z.string().url().max(500).nullable().optional(),
  clientPanelUrl: z.string().url().max(500).nullable().optional(),
  supportEmail: z.string().email().max(255).nullable().optional(),
  supportUrl: z.string().url().max(500).nullable().optional(),
  ingressBaseDomain: z.string().max(255).nullable().optional(),
  apiRateLimit: z.number().int().min(1).max(10000).optional(),
  timezone: z.string().min(1).max(50).optional(),
  // Deprecated — moved to /admin/webmail-settings. Retained here so
  // older callers don't break; the backend silently ignores them.
  mailHostname: z.string().max(255).nullable().optional(),
  webmailUrl: z.string().url().max(500).nullable().optional(),
  // Runtime-firewall toggles (migration 0062). When false, the catalog
  // deploy path rejects workloads that declare host-network ports on
  // the corresponding node role with `code: HOST_PORTS_DISABLED`.
  // Default false on a fresh install — host-port exposure is an
  // explicit operator decision.
  allowHostPortsServer: z.boolean().optional(),
  allowHostPortsWorker: z.boolean().optional(),
  // Node-defaults (migration 0063). When TRUE (default), a freshly
  // joined SERVER node that did not carry an explicit
  // `platform.phoenix-host.net/host-client-workloads` label gets
  // labelled to host client workloads by the cluster-side
  // reconciler. Operator-set labels (via bootstrap.sh
  // `--host-client-workloads`) always win.
  newServerHostsClientWorkloads: z.boolean().optional(),
  // Kubelet image-GC thresholds (migration 0065). Applied on new nodes
  // via bootstrap.sh --kubelet-arg flags. Existing nodes require a k3s
  // restart to pick up changes (Phase 2 reconciler TODO).
  // high must be > low; both in range 0–100.
  imageGcHighThreshold: z.number().int().min(50).max(95).optional(),
  imageGcLowThreshold: z.number().int().min(40).max(94).optional(),
  imageGcMinTtlMinutes: z.number().int().min(0).max(1440).optional(),
});

// ─── Response Schema ───────────────────────────────────────────────────────

export const systemSettingsResponseSchema = z.object({
  id: z.string(),
  platformName: z.string(),
  adminPanelUrl: z.string().nullable(),
  clientPanelUrl: z.string().nullable(),
  supportEmail: z.string().nullable(),
  supportUrl: z.string().nullable(),
  ingressBaseDomain: z.string().nullable(),
  mailHostname: z.string().nullable(),
  webmailUrl: z.string().nullable(),
  apiRateLimit: z.number(),
  currencySymbol: z.string(),
  timezone: z.string(),
  allowHostPortsServer: z.boolean(),
  allowHostPortsWorker: z.boolean(),
  newServerHostsClientWorkloads: z.boolean(),
  imageGcHighThreshold: z.number(),
  imageGcLowThreshold: z.number(),
  imageGcMinTtlMinutes: z.number(),
  updatedAt: z.string(),
});

// ─── Types ─────────────────────────────────────────────────────────────────

export type UpdateSystemSettingsInput = z.infer<typeof updateSystemSettingsSchema>;
export type SystemSettingsResponse = z.infer<typeof systemSettingsResponseSchema>;
