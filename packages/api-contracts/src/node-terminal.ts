import { z } from 'zod';

// ─── Admin node-terminal — privileged root shell on cluster nodes ────
//
// Opens an ephemeral privileged Pod on the target k3s node and exec's
// `nsenter -t 1 ...` to break into PID 1 host namespaces. See
// backend/src/modules/node-terminal/* for the implementation and
// docs/02-operations/NODE_TERMINAL.md for the operator runbook.
//
// Authorization:
//   • super_admin role ONLY (defence in depth via requirePanel('admin')
//     + requireRole('super_admin'))
//   • Step-up freshness gate (users.last_credential_check_at within
//     last 30 minutes — see step-up.ts)
//
// Lifecycle:
//   • POST /admin/nodes/:nodeName/terminal/sessions creates the Pod
//     + returns the WS URL bound to this replica via sticky-session
//     `replica=<pod-hostname>` query param.
//   • Client opens WS, frames stdin/resize, receives stdout/stderr.
//   • Close, idle 15min, or activeDeadlineSeconds (1h) → Pod GC.

// ─── Routing-level shapes ───────────────────────────────────────────

// Path param. Backend additionally validates against the RFC-1123
// regex shared with backend/src/modules/nodes/routes.ts.
export const nodeNameParamSchema = z.object({
  nodeName: z.string().min(1).max(253),
});
export type NodeNameParam = z.infer<typeof nodeNameParamSchema>;

export const nodeTerminalSessionIdParamSchema = z.object({
  nodeName: z.string().min(1).max(253),
  sessionId: z.string().uuid(),
});
export type NodeTerminalSessionIdParam = z.infer<typeof nodeTerminalSessionIdParamSchema>;

// ─── Session lifecycle ─────────────────────────────────────────────

// POST /admin/nodes/:nodeName/terminal/sessions — body is empty;
// node identity comes from the path.
export const createNodeTerminalSessionRequestSchema = z.object({}).strict();
export type CreateNodeTerminalSessionRequest = z.infer<typeof createNodeTerminalSessionRequestSchema>;

export const nodeTerminalSessionSchema = z.object({
  sessionId: z.string().uuid(),
  nodeName: z.string(),
  podName: z.string(),
  // Absolute wss:// URL the frontend opens. Carries:
  //   • replica=<pod-hostname>  — sticky-session anchor for HA mode
  //   • token=<ephemeral>       — single-use, sessionId-bound, 60s TTL
  websocketUrl: z.string(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  idleTimeoutSeconds: z.number().int().positive(),
});
export type NodeTerminalSession = z.infer<typeof nodeTerminalSessionSchema>;

export const createNodeTerminalSessionResponseSchema = z.object({
  data: nodeTerminalSessionSchema,
});
export type CreateNodeTerminalSessionResponse = z.infer<typeof createNodeTerminalSessionResponseSchema>;

// GET /admin/nodes/:nodeName/terminal/sessions
export const listNodeTerminalSessionsResponseSchema = z.object({
  data: z.array(nodeTerminalSessionSchema),
});
export type ListNodeTerminalSessionsResponse = z.infer<typeof listNodeTerminalSessionsResponseSchema>;

// DELETE /admin/nodes/:nodeName/terminal/sessions/:sessionId
export const deleteNodeTerminalSessionResponseSchema = z.object({
  data: z.object({
    sessionId: z.string().uuid(),
    terminated: z.literal(true),
  }),
});
export type DeleteNodeTerminalSessionResponse = z.infer<typeof deleteNodeTerminalSessionResponseSchema>;

// ─── WebSocket frame protocol (JSON discriminated union) ────────────

// Each frame is a single line of JSON over the WS. Mirrors the
// container-console pattern so xterm.js + the same hook can be reused.

export const nodeTerminalConnectedFrameSchema = z.object({
  type: z.literal('connected'),
  sessionId: z.string().uuid(),
  nodeName: z.string(),
  podName: z.string(),
});
export const nodeTerminalStdoutFrameSchema = z.object({
  type: z.literal('stdout'),
  data: z.string(),
});
export const nodeTerminalStderrFrameSchema = z.object({
  type: z.literal('stderr'),
  data: z.string(),
});
export const nodeTerminalStdinFrameSchema = z.object({
  type: z.literal('stdin'),
  data: z.string(),
});
export const nodeTerminalResizeFrameSchema = z.object({
  type: z.literal('resize'),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});
export const nodeTerminalErrorFrameSchema = z.object({
  type: z.literal('error'),
  code: z.string().optional(),
  message: z.string(),
});
export const nodeTerminalExitFrameSchema = z.object({
  type: z.literal('exit'),
  reason: z.union([
    z.literal('idle'),
    z.literal('deadline'),
    z.literal('client_close'),
    z.literal('server_close'),
    z.literal('shell_exited'),
    z.literal('error'),
  ]),
  message: z.string().optional(),
});

export const nodeTerminalServerFrameSchema = z.discriminatedUnion('type', [
  nodeTerminalConnectedFrameSchema,
  nodeTerminalStdoutFrameSchema,
  nodeTerminalStderrFrameSchema,
  nodeTerminalErrorFrameSchema,
  nodeTerminalExitFrameSchema,
]);
export type NodeTerminalServerFrame = z.infer<typeof nodeTerminalServerFrameSchema>;

export const nodeTerminalClientFrameSchema = z.discriminatedUnion('type', [
  nodeTerminalStdinFrameSchema,
  nodeTerminalResizeFrameSchema,
]);
export type NodeTerminalClientFrame = z.infer<typeof nodeTerminalClientFrameSchema>;

// ─── Error envelope (extends shared error shape for STEP_UP_REQUIRED) ─

// When createSession fails because freshness is stale, the response is
// the standard error envelope plus `details: { methods, ... }` so the
// frontend knows which step-up dialog to render.
export const stepUpRequiredErrorDetailsSchema = z.object({
  methods: z.array(z.union([z.literal('password'), z.literal('passkey')])),
  lastCredentialCheckAt: z.string().datetime().nullable(),
  maxAgeSeconds: z.number().int().positive(),
});
export type StepUpRequiredErrorDetails = z.infer<typeof stepUpRequiredErrorDetailsSchema>;
