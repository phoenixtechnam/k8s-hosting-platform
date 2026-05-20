import * as k8s from '@kubernetes/client-node';
import { PassThrough } from 'stream';
import { randomUUID, randomBytes } from 'node:crypto';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import { getNode } from '../nodes/service.js';
import { getStepUpStatus } from '../auth/step-up-service.js';
import {
  buildTerminalPodSpec,
  NSENTER_BASH_ARGV,
  TERMINAL_POD_LABEL,
  TERMINAL_POD_NAMESPACE,
} from './pod-spec.js';
import {
  register,
  getSession,
  remove,
  attachWs,
  markActivity,
  WS_TOKEN_TTL_MS,
  type TerminalSession,
  type TerminateReason,
  type TerminalSocket,
} from './session-registry.js';
import { recordNodeTerminalAudit } from './audit.js';
import * as sessionStore from './session-store.js';
import type { FastifyRequest } from 'fastify';

// Operator decision: in-memory + sticky-session URL, no concurrent cap.
// Idle timeout enforces the lifecycle along with modal-close DELETE.
export const NODE_TERMINAL_IDLE_MS = 15 * 60 * 1000; // 15 minutes
export const NODE_TERMINAL_SESSION_TTL_MS = 60 * 60 * 1000; // 1h matches pod activeDeadlineSeconds
export const WS_TOKEN_BYTES = 32; // 256 bits

// Pod readiness wait. Aligned with image-pull-on-cold-node worst case.
export const POD_READY_TIMEOUT_MS = 30_000;

export interface ServiceCtx {
  readonly db: Database;
  readonly kubeConfig: k8s.KubeConfig;
  readonly k8sCoreApi: k8s.CoreV1Api;
  readonly replicaHost: string;
}

export interface RequestActor {
  readonly userId: string;
  readonly userEmail: string;
  readonly ip: string;
}

export interface CreatedSession {
  readonly sessionId: string;
  readonly podName: string;
  readonly websocketUrl: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly nodeName: string;
}

export interface CreateSessionOpts {
  readonly nodeName: string;
  readonly image?: string;
  /** Bound public origin used to construct the wss:// URL surfaced to clients. */
  readonly publicWssOrigin: string;
  /** When false, skip the step-up freshness check. Test-only override. */
  readonly skipStepUpForTest?: boolean;
}

/**
 * Create a privileged Pod on the target node + register the session.
 * Does NOT attach the WS yet — the client calls back through the
 * websocketUrl. The ephemeral wsToken in the URL is consumed (single-
 * use, constant-time-compared) by attachExec().
 */
export async function createSession(
  ctx: ServiceCtx,
  actor: RequestActor,
  opts: CreateSessionOpts,
  request: FastifyRequest,
): Promise<CreatedSession> {
  // 1) Freshness gate — step-up required unless within window.
  if (!opts.skipStepUpForTest) {
    const status = await getStepUpStatus(ctx.db, actor.userId);
    if (status.required) {
      // Security finding H1: an OIDC-only super_admin has NO local
      // credential to step up with. We surface STEP_UP_UNAVAILABLE so
      // the operator hears "your account can't open this" instead of
      // a recursive step-up loop. Operator must enroll a password or
      // passkey before they can open a node terminal.
      if (status.methods.length === 0) {
        await recordNodeTerminalAudit(ctx.db, {
          actorId: actor.userId,
          nodeName: opts.nodeName,
          action: 'node_terminal.session.create.failed',
          httpStatus: 409,
          request,
          changes: { reason: 'STEP_UP_UNAVAILABLE' },
        });
        throw new ApiError(
          'STEP_UP_UNAVAILABLE',
          'Your account has no step-up method enrolled (no password, no passkey). Enroll a credential before opening a node terminal.',
          409,
          { reason: 'NO_STEP_UP_METHOD_AVAILABLE' },
          'Add a passkey under Profile → Passkeys, then retry.',
        );
      }
      await recordNodeTerminalAudit(ctx.db, {
        actorId: actor.userId,
        nodeName: opts.nodeName,
        action: 'node_terminal.session.create.failed',
        httpStatus: 403,
        request,
        changes: { reason: 'STEP_UP_REQUIRED', methods: status.methods },
      });
      throw new ApiError(
        'STEP_UP_REQUIRED',
        'A fresh credential check is required to open a node terminal. Re-authenticate to continue.',
        403,
        {
          methods: status.methods,
          lastCredentialCheckAt: status.lastCredentialCheckAt?.toISOString() ?? null,
          maxAgeSeconds: Math.floor(status.maxAgeMs / 1000),
        },
        'POST /api/v1/me/step-up/{password|passkey/verify} with your active credential, then retry.',
      );
    }
  }

  // 2) Node must exist + be Ready. NotReady → 409 (transient
  //    operator concern, not a 404 — the node is known but down).
  const node = await getNode(ctx.db, opts.nodeName);
  if (!node) {
    await recordNodeTerminalAudit(ctx.db, {
      actorId: actor.userId,
      nodeName: opts.nodeName,
      action: 'node_terminal.session.create.failed',
      httpStatus: 404,
      request,
      changes: { reason: 'NODE_NOT_FOUND' },
    });
    throw new ApiError('NODE_NOT_FOUND', `Unknown cluster node: ${opts.nodeName}`, 404);
  }
  const readyCond = node.statusConditions?.find((c) => c.type === 'Ready');
  if (readyCond?.status !== 'True') {
    await recordNodeTerminalAudit(ctx.db, {
      actorId: actor.userId,
      nodeName: opts.nodeName,
      action: 'node_terminal.session.create.failed',
      httpStatus: 409,
      request,
      changes: { reason: 'NODE_NOT_READY', readyStatus: readyCond?.status ?? 'Unknown' },
    });
    throw new ApiError(
      'NODE_NOT_READY',
      `Node ${opts.nodeName} is not Ready; cannot open a terminal session.`,
      409,
    );
  }

  // 3) Audit the attempt BEFORE provisioning anything. If the create
  //    succeeds but the success-audit later fails, we still have a row
  //    proving the user initiated this.
  const sessionId = randomUUID();
  await recordNodeTerminalAudit(ctx.db, {
    actorId: actor.userId,
    nodeName: opts.nodeName,
    sessionId,
    action: 'node_terminal.session.create.attempt',
    request,
    changes: { image: opts.image },
  });

  // 4) Provision the Pod. ownerReferences left undefined for now —
  //    the orphan sweeper + activeDeadlineSeconds + DELETE-on-close
  //    cover cleanup. Wiring an ownerReference to platform-api's own
  //    Deployment requires a downward-API lookup we don't yet have.
  const pod = buildTerminalPodSpec({
    nodeName: opts.nodeName,
    sessionId,
    image: opts.image,
  });
  let createdPod: k8s.V1Pod;
  try {
    const resp = await ctx.k8sCoreApi.createNamespacedPod({
      namespace: TERMINAL_POD_NAMESPACE,
      body: pod,
    });
    createdPod = resp;
  } catch (err) {
    await recordNodeTerminalAudit(ctx.db, {
      actorId: actor.userId,
      nodeName: opts.nodeName,
      sessionId,
      action: 'node_terminal.session.create.failed',
      httpStatus: 500,
      request,
      changes: {
        reason: 'POD_CREATE_FAILED',
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw new ApiError(
      'NODE_TERMINAL_POD_CREATE_FAILED',
      'Failed to provision the privileged terminal Pod.',
      500,
      { sessionId },
    );
  }
  const podName = createdPod.metadata?.name ?? '';

  // 5) Wait for the Pod to reach Running so the exec channel has a
  //    target. Timeout → tear down and surface 504 so the client can
  //    retry cleanly.
  try {
    await waitForPodRunning(ctx.k8sCoreApi, podName, POD_READY_TIMEOUT_MS);
  } catch (err) {
    // Cleanup the Pod that won't be used. Best-effort.
    await ctx.k8sCoreApi
      .deleteNamespacedPod({ namespace: TERMINAL_POD_NAMESPACE, name: podName, gracePeriodSeconds: 5 })
      .catch(() => undefined);
    await recordNodeTerminalAudit(ctx.db, {
      actorId: actor.userId,
      nodeName: opts.nodeName,
      sessionId,
      action: 'node_terminal.session.create.failed',
      httpStatus: 504,
      request,
      changes: {
        reason: 'POD_READY_TIMEOUT',
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw new ApiError(
      'NODE_TERMINAL_POD_TIMEOUT',
      'Terminal Pod did not reach Running state in time.',
      504,
      { sessionId, podName, timeoutMs: POD_READY_TIMEOUT_MS },
    );
  }

  // 6) Register the session with an ephemeral, sessionId-bound WS token.
  const wsToken = randomBytes(WS_TOKEN_BYTES).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + NODE_TERMINAL_SESSION_TTL_MS);
  const session: TerminalSession = {
    id: sessionId,
    nodeName: opts.nodeName,
    podName,
    userId: actor.userId,
    userEmail: actor.userEmail,
    ip: actor.ip,
    createdAt: now,
    expiresAt,
    wsToken,
    wsTokenIssuedAt: now,
    ws: null,
    lastActivityAt: now,
  };
  register(session);

  // 6b) Persist to DB so any platform-api replica can attach later
  //     (HA stickiness fix per ADR-041 evolved spec). Raw token never
  //     hits the DB — only a SHA-256 hash for constant-time compare.
  try {
    await sessionStore.insertSession(ctx.db, {
      id: sessionId,
      nodeName: opts.nodeName,
      podName,
      userId: actor.userId,
      userEmail: actor.userEmail,
      clientIp: actor.ip,
      wsToken,
      ownerReplica: ctx.replicaHost,
      expiresAt,
    });
  } catch (err) {
    // DB insert failed — roll back the Pod + in-memory entry so we
    // don't leave an orphan that no one can ever attach to.
    remove(sessionId);
    await ctx.k8sCoreApi
      .deleteNamespacedPod({ namespace: TERMINAL_POD_NAMESPACE, name: podName, gracePeriodSeconds: 5 })
      .catch(() => undefined);
    await recordNodeTerminalAudit(ctx.db, {
      actorId: actor.userId,
      nodeName: opts.nodeName,
      sessionId,
      action: 'node_terminal.session.create.failed',
      httpStatus: 500,
      request,
      changes: {
        reason: 'DB_INSERT_FAILED',
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw new ApiError(
      'NODE_TERMINAL_DB_FAILED',
      'Failed to persist the terminal session row. The privileged Pod has been cleaned up.',
      500,
      { sessionId, podName },
    );
  }

  // 7) Build the sticky-session websocketUrl. The replica anchor is
  //    just hostname; the load-balancer needs an upstream hash header
  //    or equivalent to honour stickiness. Documented in the runbook.
  const url = new URL(`/api/v1/admin/nodes/${encodeURIComponent(opts.nodeName)}/terminal/sessions/${sessionId}/ws`, opts.publicWssOrigin);
  url.searchParams.set('token', wsToken);
  url.searchParams.set('replica', ctx.replicaHost);
  const websocketUrl = url.toString();

  await recordNodeTerminalAudit(ctx.db, {
    actorId: actor.userId,
    nodeName: opts.nodeName,
    sessionId,
    action: 'node_terminal.session.create.success',
    request,
    changes: { podName, expiresAt: expiresAt.toISOString() },
  });

  return { sessionId, podName, websocketUrl, createdAt: now, expiresAt, nodeName: opts.nodeName };
}

/**
 * Attach a websocket to an existing session and stream the exec.
 * Validates the single-use token, mounts stdout/stderr/stdin streams,
 * and frames everything as JSON over the WS.
 */
export async function attachExec(
  ctx: ServiceCtx,
  sessionId: string,
  presentedToken: string,
  expectedUserId: string,
  socket: TerminalSocket,
  request: FastifyRequest,
  /** ?replica=<pod-hostname> from the wsUrl — used to detect when
   *  HA stickiness routed the WS upgrade to a different replica than
   *  the one that created the session. */
  expectedReplica?: string,
): Promise<void> {
  // ── DB-authoritative session lookup (ADR-041 evolved spec) ────────
  // Replaces the previous per-replica in-memory lookup that broke
  // under HA. Any platform-api replica can now serve any session.
  //
  // Flow:
  //   1. Try DB lookup by sessionId. Not found → SESSION_NOT_FOUND
  //      (expired/terminated/never-existed). Found → carry on.
  //   2. Verify the row's userId matches the JWT-authenticated user.
  //   3. Atomically validate + burn the wsToken (single-use, 60s TTL,
  //      hash-compared in SQL).
  //   4. Claim ownership: update `owner_replica = ctx.replicaHost`.
  //   5. The in-memory `session-registry` Map becomes the local fast
  //      path for the live WS+stream handles only — DB is authority.
  let dbSession = await sessionStore.findById(ctx.db, sessionId);
  if (!dbSession) {
    request.log.warn({ sessionId, localReplica: ctx.replicaHost }, 'node-terminal WS upgrade for unknown session');
    sendFrame(socket, {
      type: 'error',
      code: 'SESSION_NOT_FOUND',
      message: `Session ${sessionId} not found (may have expired, been terminated, or never existed).`,
    });
    await recordNodeTerminalAudit(ctx.db, {
      actorId: expectedUserId,
      nodeName: '',
      sessionId,
      action: 'node_terminal.session.ws.rejected',
      httpStatus: 404,
      request,
      changes: { reason: 'SESSION_NOT_FOUND', localReplica: ctx.replicaHost },
    });
    socket.close(4404, 'No session');
    return;
  }
  if (dbSession.userId !== expectedUserId) {
    sendFrame(socket, { type: 'error', code: 'OWNER_MISMATCH', message: 'Session belongs to a different user' });
    socket.close(4403, 'Forbidden');
    await recordNodeTerminalAudit(ctx.db, {
      actorId: expectedUserId,
      nodeName: dbSession.nodeName,
      sessionId,
      action: 'node_terminal.session.ws.rejected',
      httpStatus: 403,
      request,
      changes: { reason: 'OWNER_MISMATCH' },
    });
    return;
  }
  // Atomic consume: returns the row only if the token matched AND
  // was still unconsumed AND was within the TTL window. The same
  // SQL also nulls the hash so replay is impossible.
  const consumed = await sessionStore.consumeWsToken(ctx.db, sessionId, presentedToken);
  if (!consumed) {
    sendFrame(socket, { type: 'error', code: 'TOKEN_INVALID', message: 'Invalid or already-used session token' });
    socket.close(4401, 'Unauthorized');
    await recordNodeTerminalAudit(ctx.db, {
      actorId: expectedUserId,
      nodeName: dbSession.nodeName,
      sessionId,
      action: 'node_terminal.session.ws.rejected',
      httpStatus: 401,
      request,
      changes: { reason: 'TOKEN_INVALID' },
    });
    return;
  }
  // Mark this replica as the new owner — diagnostic only, but visible
  // in `audit_logs.changes` and in the runbook's session listing.
  const replicaTransfer = dbSession.ownerReplica !== ctx.replicaHost;
  await sessionStore.updateOwnerReplica(ctx.db, sessionId, ctx.replicaHost);
  // Refresh local snapshot to reflect the consumed-token state.
  dbSession = consumed;

  // Hydrate in-memory entry if this is a cross-replica re-attach.
  // The session may not exist in this replica's local registry; we
  // synthesise one so attachWs/markActivity/finalize all work.
  if (!getSession(sessionId)) {
    register({
      id: dbSession.id,
      nodeName: dbSession.nodeName,
      podName: dbSession.podName,
      userId: dbSession.userId,
      userEmail: dbSession.userEmail,
      ip: dbSession.clientIp,
      createdAt: dbSession.createdAt,
      expiresAt: dbSession.expiresAt,
      wsToken: null, // already consumed
      wsTokenIssuedAt: dbSession.createdAt,
      ws: null,
      lastActivityAt: dbSession.lastActivityAt,
    });
  }
  // Alias to keep the existing handler code working unchanged below.
  const session = getSession(sessionId)!;

  attachWs(sessionId, socket);
  if (replicaTransfer) {
    request.log.info({
      sessionId,
      newOwner: ctx.replicaHost,
      previousOwner: dbSession.ownerReplica,
    }, 'node-terminal session ownership transferred to this replica');
  }
  await recordNodeTerminalAudit(ctx.db, {
    actorId: expectedUserId,
    nodeName: session.nodeName,
    sessionId,
    action: 'node_terminal.session.ws.attached',
    request,
  });

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  let closed = false;

  // Resize forwarding to kubelet. The k8s exec WebSocket multiplexes
  // streams over channel-prefixed frames (V4 protocol):
  //   channel 0 = stdin
  //   channel 1 = stdout
  //   channel 2 = stderr
  //   channel 3 = error
  //   channel 4 = resize  ← JSON {"Width": cols, "Height": rows}
  //
  // @kubernetes/client-node does NOT auto-forward terminal size — the
  // PassThrough streams above only carry stdin/stdout/stderr. Without
  // this, programs like top/htop start at the default 80x24 and never
  // resize, even when xterm sends fresh resize frames on every layout
  // change.
  let wsConn: { close?: () => void; send?: (data: Buffer) => void } | undefined;
  // Wrapped in an object so the closure write in sendResizeToKubelet
  // propagates through TS's control-flow analysis on later reads.
  const pending: { resize: { cols: number; rows: number } | null } = { resize: null };

  const sendResizeToKubelet = (cols: number, rows: number): void => {
    if (!wsConn?.send) {
      // Exec stream not ready yet — buffer the latest size; we'll
      // flush it once `await exec.exec()` resolves below.
      pending.resize = { cols, rows };
      return;
    }
    // Reject ridiculous sizes — k8s caps at uint16 in practice.
    if (cols < 1 || rows < 1 || cols > 10_000 || rows > 10_000) return;
    const payload = `{"Width":${cols},"Height":${rows}}`;
    const buf = Buffer.alloc(1 + Buffer.byteLength(payload, 'utf8'));
    buf[0] = 4; // resize channel
    buf.write(payload, 1, 'utf8');
    try { wsConn.send(buf); } catch { /* socket may have closed concurrently */ }
  };

  // Wire the stdin handler BEFORE the 'connected' frame goes out so
  // any data the client sends in response to that frame isn't lost in
  // the gap between connect-ack and exec-stream-attach. The
  // PassThrough buffers writes until the exec.exec() pipeline plugs
  // it into the k8s API server stream.
  socket.on('message', (raw: Buffer | string) => {
    if (closed) return;
    try {
      const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
      const parsed = JSON.parse(text) as { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown };
      if (parsed.type === 'stdin' && typeof parsed.data === 'string') {
        // markActivity ONLY on user-driven frames — keepalive pings
        // must not refresh the 15-min idle timer (otherwise minimized
        // sessions never expire).
        markActivity(sessionId);
        stdin.write(parsed.data);
        return;
      }
      if (parsed.type === 'resize' && typeof parsed.cols === 'number' && typeof parsed.rows === 'number') {
        markActivity(sessionId);
        sendResizeToKubelet(parsed.cols, parsed.rows);
        return;
      }
      // Any other frame (ping/pong/etc.) is silently accepted but does
      // NOT count as activity. The WS-level protocol ping the server
      // sends every 30s + the browser's auto-pong already keeps the
      // socket alive across NAT/proxies — no application-level keepalive
      // is needed here.
    } catch {
      // Malformed frame — drop. Don't crash the WS.
    }
  });

  sendFrame(socket, {
    type: 'connected',
    sessionId,
    nodeName: session.nodeName,
    podName: session.podName,
  });

  const finalize = async (reason: TerminateReason): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      sendFrame(socket, { type: 'exit', reason });
    } catch { /* socket already gone */ }
    stdin.destroy();
    stdout.destroy();
    stderr.destroy();
    await terminateSession(ctx, sessionId, reason, request).catch(() => undefined);
    try { socket.close(1000, reason); } catch { /* already closed */ }
  };

  socket.on('close', () => { void finalize('client_close'); });
  socket.on('error', () => { void finalize('error'); });

  try {
    const exec = new k8s.Exec(ctx.kubeConfig);
    wsConn = await exec.exec(
      TERMINAL_POD_NAMESPACE,
      session.podName,
      'shell',
      // The argv vector — nsenter into PID 1 namespaces + bash -l.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      NSENTER_BASH_ARGV as any,
      stdout,
      stderr,
      stdin,
      true, // tty
    ) as { close?: () => void; send?: (data: Buffer) => void };
    // Flush any resize that arrived between the WS upgrade and the
    // exec stream becoming ready.
    if (pending.resize) {
      const { cols, rows } = pending.resize;
      pending.resize = null;
      sendResizeToKubelet(cols, rows);
    }
  } catch (err) {
    sendFrame(socket, {
      type: 'error',
      code: 'EXEC_FAILED',
      message: err instanceof Error ? err.message : 'Failed to attach exec stream',
    });
    await finalize('error');
    return;
  }

  stdout.on('data', (chunk: Buffer) => {
    if (closed) return;
    markActivity(sessionId);
    try {
      sendFrame(socket, { type: 'stdout', data: chunk.toString() });
    } catch { void finalize('error'); }
  });
  stderr.on('data', (chunk: Buffer) => {
    if (closed) return;
    markActivity(sessionId);
    try {
      sendFrame(socket, { type: 'stderr', data: chunk.toString() });
    } catch { void finalize('error'); }
  });
  stdout.on('end', () => { void finalize('shell_exited'); });
  // Some k8s exec TTY paths close stderr first; without an `end`
  // listener the streams + heartbeat would leak until idle timeout.
  stderr.on('end', () => { void finalize('shell_exited'); });

  // Heartbeat at 30s — also keeps mid-NAT proxies from culling the
  // socket. Idle timeout is enforced separately by the scheduler.
  const heartbeat = setInterval(() => {
    if (closed) { clearInterval(heartbeat); return; }
    try { socket.ping(); } catch { void finalize('error'); clearInterval(heartbeat); }
  }, 30_000);
  socket.on('close', () => clearInterval(heartbeat));

  // Tie the wsConn into finalize so a manual close releases server resources.
  socket.once('close', () => {
    try { wsConn?.close?.(); } catch { /* already closed */ }
  });
}

/**
 * Delete the privileged Pod + remove the session from the registry.
 * Idempotent — calling twice is a no-op on the second call.
 *
 * `requestingUserId` distinguishes "session owner closed their own
 * shell" from "another super_admin force-closed someone else's"
 * (security finding M1). The audit logs the actor (requestor) and
 * mirrors the session owner in `changes.sessionOwnerId`.
 */
export async function terminateSession(
  ctx: ServiceCtx,
  sessionId: string,
  reason: TerminateReason,
  request: FastifyRequest,
  requestingUserId?: string,
): Promise<void> {
  // Look up the DB row FIRST so we have authoritative metadata even
  // when this replica didn't create the session (cross-replica close).
  const dbSession = await sessionStore.findById(ctx.db, sessionId);
  // Local in-memory may be set (this replica owned it) or not (this
  // replica only proxied the close request). Either way, evict.
  const memSession = remove(sessionId);
  if (!dbSession && !memSession) return;
  if (memSession) {
    try { memSession.ws?.close(1000, reason); } catch { /* already closed */ }
  }
  const podName = dbSession?.podName ?? memSession?.podName;
  const nodeName = dbSession?.nodeName ?? memSession?.nodeName ?? '';
  const ownerUserId = dbSession?.userId ?? memSession?.userId ?? '';
  const ownerEmail = dbSession?.userEmail ?? memSession?.userEmail ?? '';
  const createdAt = dbSession?.createdAt ?? memSession?.createdAt ?? new Date();
  if (podName) {
    try {
      await ctx.k8sCoreApi.deleteNamespacedPod({
        namespace: TERMINAL_POD_NAMESPACE,
        name: podName,
        gracePeriodSeconds: 5,
      });
    } catch {
      // 404 is fine — Pod might have been GC'd by activeDeadline or
      // ownerRef cascade. Anything else we log via audit changes.
    }
  }
  // Always remove the DB row last — once it's gone, any racing WS
  // upgrade will get SESSION_NOT_FOUND instead of a dangling row.
  await sessionStore.deleteSession(ctx.db, sessionId).catch(() => undefined);
  const actorId = requestingUserId ?? ownerUserId;
  await recordNodeTerminalAudit(ctx.db, {
    actorId,
    nodeName,
    sessionId,
    action: 'node_terminal.session.closed',
    request,
    changes: {
      reason,
      durationMs: Date.now() - createdAt.getTime(),
      podName,
      sessionOwnerId: ownerUserId,
      sessionOwnerEmail: ownerEmail,
      ...(requestingUserId && requestingUserId !== ownerUserId ? { forcedByDifferentUser: true } : {}),
    },
  });
}

// ─── Internal helpers ──────────────────────────────────────────────

function consumeWsTokenForSession(session: TerminalSession, presented: string): boolean {
  if (session.wsToken === null) return false;
  // TTL enforcement (security finding C1). Burn the token even on
  // expiry so a slow attacker can't keep racing the comparison.
  if (Date.now() - session.wsTokenIssuedAt.getTime() > WS_TOKEN_TTL_MS) {
    session.wsToken = null;
    return false;
  }
  if (session.wsToken.length !== presented.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) {
    diff |= session.wsToken.charCodeAt(i) ^ presented.charCodeAt(i);
  }
  if (diff !== 0) return false;
  session.wsToken = null;
  return true;
}

function sendFrame(socket: TerminalSocket, frame: Record<string, unknown>): void {
  socket.send(JSON.stringify(frame));
}

/**
 * Poll the Pod until phase === 'Running' or the deadline elapses.
 * Throws on timeout; caller handles cleanup.
 */
async function waitForPodRunning(
  api: k8s.CoreV1Api,
  podName: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pod = await api.readNamespacedPod({ namespace: TERMINAL_POD_NAMESPACE, name: podName });
      const phase = pod?.status?.phase;
      if (phase === 'Running') return;
      if (phase === 'Failed' || phase === 'Succeeded') {
        throw new Error(`Pod entered terminal phase ${phase} before Running`);
      }
    } catch (err) {
      // 404 in the first ~50ms after createNamespacedPod returns is
      // not unusual — re-poll. Re-throw on persistent errors.
      const code = (err as { code?: number; statusCode?: number })?.statusCode
        ?? (err as { code?: number })?.code;
      if (code !== 404) throw err;
    }
    await sleep(500);
  }
  throw new Error('Pod did not reach Running phase before deadline');
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ─── Orphan-pod sweeper (run from scheduler.ts) ────────────────────

/**
 * Reap any privileged terminal Pods labelled by us that don't
 * correspond to a DB session row AND were created more than
 * `staleSafetyMs` ago. Defends against: (a) platform-api crashed
 * after Pod create but before DB insert, (b) some other code path
 * created a Pod with our label by accident, (c) DB row was already
 * deleted (e.g. orphaned by a partial terminate).
 *
 * The check is DB-backed now (was per-replica in-memory) so any
 * replica's sweeper can correctly identify orphans cluster-wide.
 */
export async function sweepOrphanPods(
  ctx: ServiceCtx,
  staleSafetyMs: number = 5 * 60 * 1000,
): Promise<number> {
  const list = await ctx.k8sCoreApi
    .listNamespacedPod({
      namespace: TERMINAL_POD_NAMESPACE,
      labelSelector: `${TERMINAL_POD_LABEL}=true`,
    })
    .catch(() => null);
  if (!list?.items?.length) return 0;
  const now = Date.now();
  let deleted = 0;
  for (const pod of list.items) {
    const name = pod.metadata?.name;
    const sessionId = pod.metadata?.labels?.['platform.phoenix-host.net/session-id'];
    const createdAt = pod.metadata?.creationTimestamp
      ? new Date(pod.metadata.creationTimestamp).getTime()
      : 0;
    if (!name || !sessionId) continue;
    if (now - createdAt < staleSafetyMs) continue;
    // Tracked in DB? Leave it alone (any replica can re-attach).
    const dbRow = await sessionStore.findById(ctx.db, sessionId).catch(() => null);
    if (dbRow) continue;
    await ctx.k8sCoreApi
      .deleteNamespacedPod({
        namespace: TERMINAL_POD_NAMESPACE,
        name,
        gracePeriodSeconds: 5,
      })
      .catch(() => undefined);
    deleted++;
  }
  return deleted;
}
