// Structural type that captures only the methods we touch — avoids
// pulling @types/ws (not in package.json) and matches what
// @fastify/websocket hands the handler.
export interface TerminalSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  ping(): void;
  on(event: 'close' | 'error', listener: () => void): void;
  on(event: 'message', listener: (data: Buffer | string) => void): void;
  once(event: 'close', listener: () => void): void;
}

/**
 * In-memory registry of active terminal sessions. One instance per
 * platform-api Pod — the websocketUrl returned to the client carries
 * a `replica=<pod-hostname>` query param so the WS upgrade is sticky
 * to the originating replica. If that replica restarts mid-session,
 * the WS drops and the frontend surfaces a Reconnect button (creates
 * a new session, new sessionId, new audit row).
 *
 * Why in-memory:
 *   • The WS handle is a per-process resource — DB-backed state would
 *     not let another replica resume the stream anyway.
 *   • Privileged Pods are GC'd by `ownerReferences` cascade if
 *     platform-api itself crashes, by the orphan sweeper if a single
 *     session leaks, and by `activeDeadlineSeconds` as the backstop.
 *   • Operator's explicit decision: in-memory + sticky URL, no concurrent
 *     cap, Reconnect button on flap.
 */

export interface TerminalSession {
  readonly id: string;
  readonly nodeName: string;
  readonly podName: string;
  readonly userId: string;
  readonly userEmail: string;
  readonly ip: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  /**
   * Single-use WS token bound to this session. Replaced with `null`
   * the moment the WS upgrades, so a stolen URL can't be replayed.
   */
  wsToken: string | null;
  /** Token issuance timestamp. Used by consumeWsToken to enforce TTL. */
  wsTokenIssuedAt: Date;
  /** Set after the WS upgrade. Null while the session is pending. */
  ws: TerminalSocket | null;
  lastActivityAt: Date;
}

export type TerminateReason =
  | 'client_close'
  | 'idle'
  | 'deadline'
  | 'server_close'
  | 'shell_exited'
  | 'error';

const REGISTRY = new Map<string, TerminalSession>();

export function register(session: TerminalSession): void {
  REGISTRY.set(session.id, session);
}

export function getSession(sessionId: string): TerminalSession | undefined {
  return REGISTRY.get(sessionId);
}

export function listSessions(): readonly TerminalSession[] {
  return Array.from(REGISTRY.values());
}

export function listSessionsForNode(nodeName: string): readonly TerminalSession[] {
  return Array.from(REGISTRY.values()).filter((s) => s.nodeName === nodeName);
}

export function remove(sessionId: string): TerminalSession | undefined {
  const existing = REGISTRY.get(sessionId);
  if (existing) REGISTRY.delete(sessionId);
  return existing;
}

export function markActivity(sessionId: string): void {
  const s = REGISTRY.get(sessionId);
  if (s) s.lastActivityAt = new Date();
}

export const WS_TOKEN_TTL_MS = 60_000; // matches the api-contracts comment

export function consumeWsToken(sessionId: string, presentedToken: string): boolean {
  const s = REGISTRY.get(sessionId);
  if (!s || s.wsToken === null) return false;
  // TTL enforcement — fixes security finding C1. A token left
  // unconsumed past TTL is dead even before the session lifetime
  // ends, shrinking the replay window for a leaked URL.
  if (Date.now() - s.wsTokenIssuedAt.getTime() > WS_TOKEN_TTL_MS) {
    s.wsToken = null;
    return false;
  }
  // Constant-time comparison avoids leaking the token via timing.
  if (!constantTimeEquals(s.wsToken, presentedToken)) return false;
  s.wsToken = null;
  return true;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function attachWs(sessionId: string, ws: TerminalSocket): void {
  const s = REGISTRY.get(sessionId);
  if (s) {
    s.ws = ws;
    s.lastActivityAt = new Date();
  }
}

/** Sessions whose `lastActivityAt` is older than `idleMs` ago. */
export function findIdle(idleMs: number, now: Date = new Date()): readonly TerminalSession[] {
  const cutoff = now.getTime() - idleMs;
  return Array.from(REGISTRY.values()).filter((s) => s.lastActivityAt.getTime() < cutoff);
}

/** Test-only — wipes the registry between tests. */
export function _resetForTests(): void {
  REGISTRY.clear();
}
