import { z } from 'zod';

/**
 * GET /admin/mail/health
 *
 * Real, verified mail-server health. Replaces the cosmetic "Mail Server
 * Status" tile that just echoed the operator's intent (placement +
 * port-exposure settings) without ever talking to the cluster. The
 * 2026-05-14 streamline made this an actual probe set.
 *
 * Each component reports `healthy: boolean` independently — the
 * top-level `healthy` is the AND of all components. Operator UI
 * (Phase-5 banner drill-down) renders the components in order:
 *
 *   pod        — does the Stalwart pod exist + is its `stalwart`
 *                container ready? Returns node name + phase. This
 *                catches CrashLoopBackOff, ImagePullBackOff, restore-
 *                state initContainer hangs, etc.
 *
 *   jmap       — does Stalwart actually answer JMAP? We call
 *                `Server/get` and report the response time + version.
 *                Catches "pod ready but RocksDB lock failed" and
 *                similar split-brain shapes.
 *
 *   rocksdb    — exec `stalwart -e check` inside the pod (or
 *                equivalent open-only validation). Catches DataStore
 *                corruption while pod and JMAP are both green. SHIPS
 *                as null/`not_implemented` in Phase 3a; populated in
 *                Phase 3b once the read-only check helper is wired
 *                into the Stalwart pod's command surface.
 *
 *   cert       — TLS cert serving on each mail port: validity window,
 *                issuer, days-until-expiry. SHIPS as null in Phase 3a;
 *                Phase 3b reuses the existing ssl-status cache.
 *
 *   tcp        — TCP reach (from the platform-api pod, which is on a
 *                different node) on every mail port. SHIPS as null in
 *                Phase 3a; Phase 3b implements with node-mode-aware
 *                target selection (Service VIP in allServerNodes mode,
 *                hostPort in thisNodeOnly mode).
 *
 * Backend caches the full response for `cachedFor` seconds (default
 * 30s). UI must NOT poll faster than the cache window — instead use
 * an explicit `?refresh=1` query param when the operator clicks
 * "Re-check now".
 */

const componentStatusSchema = z.object({
  healthy: z.boolean(),
  error: z.string().nullable(),
});

export const mailHealthPodComponentSchema = componentStatusSchema.extend({
  podName: z.string().nullable(),
  node: z.string().nullable(),
  phase: z.enum(['Pending', 'Running', 'Succeeded', 'Failed', 'Unknown']).nullable(),
  containerReady: z.boolean().nullable(),
  restartCount: z.number().int().nonnegative().nullable(),
  initContainerStatus: z.string().nullable(),
});

export const mailHealthJmapComponentSchema = componentStatusSchema.extend({
  durationMs: z.number().int().nonnegative().nullable(),
  serverName: z.string().nullable(),
  serverVersion: z.string().nullable(),
});

export const mailHealthOptionalComponentSchema = componentStatusSchema.extend({
  status: z.enum(['ok', 'fail', 'not_implemented']),
});

export const mailHealthResponseSchema = z.object({
  healthy: z.boolean(),
  components: z.object({
    pod: mailHealthPodComponentSchema,
    jmap: mailHealthJmapComponentSchema,
    rocksdb: mailHealthOptionalComponentSchema,
    cert: mailHealthOptionalComponentSchema,
    tcp: mailHealthOptionalComponentSchema,
  }),
  checkedAt: z.string().datetime(),
  cachedFor: z.number().int().nonnegative(),
});
export type MailHealthResponse = z.infer<typeof mailHealthResponseSchema>;
export type MailHealthPodComponent = z.infer<typeof mailHealthPodComponentSchema>;
export type MailHealthJmapComponent = z.infer<typeof mailHealthJmapComponentSchema>;
export type MailHealthOptionalComponent = z.infer<typeof mailHealthOptionalComponentSchema>;
