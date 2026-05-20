import crypto from 'node:crypto';
import { eq, lt, and, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { nodeTerminalSessions, type NodeTerminalSessionRow } from '../../db/schema.js';

// ─── DB-backed node-terminal session store (ADR-041 evolved spec) ────
//
// Authority for "does session X exist, and what's its wsToken?" — the
// in-memory `session-registry.ts` Map remains as the owner-replica
// fast path for the live WS handle (which can't be serialised), but
// every existence check goes through here.

export interface SessionRow {
  readonly id: string;
  readonly nodeName: string;
  readonly podName: string;
  readonly podNamespace: string;
  readonly userId: string;
  readonly userEmail: string;
  readonly clientIp: string;
  readonly ownerReplica: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastActivityAt: Date;
}

export interface InsertInput {
  readonly id: string;
  readonly nodeName: string;
  readonly podName: string;
  readonly podNamespace?: string;
  readonly userId: string;
  readonly userEmail: string;
  readonly clientIp: string;
  readonly wsToken: string;
  readonly ownerReplica: string;
  readonly expiresAt: Date;
}

/** SHA-256 of the wsToken — token entropy is already 256 bits random
 *  (crypto.randomBytes(32)), so a cryptographic hash with no salt is
 *  appropriate. A salted KDF (argon2/bcrypt) is for low-entropy
 *  passwords; for a 256-bit random secret, SHA-256 + constant-time
 *  compare is correct. */
export function hashWsToken(rawToken: string): Buffer {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest();
}

function rowToSession(r: NodeTerminalSessionRow): SessionRow {
  return {
    id: r.id,
    nodeName: r.nodeName,
    podName: r.podName,
    podNamespace: r.podNamespace,
    userId: r.userId,
    userEmail: r.userEmail,
    clientIp: r.clientIp,
    ownerReplica: r.ownerReplica,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    lastActivityAt: r.lastActivityAt,
  };
}

/** Insert a fresh session row. Caller hashes the wsToken — never
 *  stores the raw token. Used by createSession in service.ts. */
export async function insertSession(db: Database, input: InsertInput): Promise<void> {
  await db.insert(nodeTerminalSessions).values({
    id: input.id,
    nodeName: input.nodeName,
    podName: input.podName,
    podNamespace: input.podNamespace ?? 'platform',
    userId: input.userId,
    userEmail: input.userEmail,
    clientIp: input.clientIp,
    wsTokenHash: hashWsToken(input.wsToken),
    wsTokenIssuedAt: new Date(),
    ownerReplica: input.ownerReplica,
    expiresAt: input.expiresAt,
  });
}

/** Fetch a session by id. Returns null if not found OR expired. */
export async function findById(db: Database, sessionId: string): Promise<SessionRow | null> {
  const [row] = await db
    .select()
    .from(nodeTerminalSessions)
    .where(eq(nodeTerminalSessions.id, sessionId))
    .limit(1);
  if (!row) return null;
  // Treat expired rows as not-found from the caller's POV. The
  // sweeper deletes them; we just don't honour them here.
  if (row.expiresAt.getTime() < Date.now()) return null;
  return rowToSession(row);
}

/** Atomically validate the wsToken and burn it in one SQL statement.
 *  Returns the session row IF (and only if) the presented hash matched
 *  an active row whose token was issued within the TTL window AND was
 *  not already consumed. The hash slot is set to NULL atomically so
 *  the same token can never be replayed.
 *
 *  Note: the comparison is by exact hash equality at the DB level —
 *  Postgres compares bytea byte-for-byte without short-circuit, which
 *  is the same constant-time property we want.
 */
export async function consumeWsToken(
  db: Database,
  sessionId: string,
  presentedToken: string,
  ttlMs: number = 60_000,
): Promise<SessionRow | null> {
  const presentedHash = hashWsToken(presentedToken);
  const cutoff = new Date(Date.now() - ttlMs);
  const [row] = await db
    .update(nodeTerminalSessions)
    .set({ wsTokenHash: null, wsTokenIssuedAt: null, lastActivityAt: new Date() })
    .where(
      and(
        eq(nodeTerminalSessions.id, sessionId),
        eq(nodeTerminalSessions.wsTokenHash, presentedHash),
        // wsTokenIssuedAt > now - ttl
        sql`${nodeTerminalSessions.wsTokenIssuedAt} > ${cutoff}`,
      ),
    )
    .returning();
  if (!row) return null;
  return rowToSession(row);
}

/** Replace the wsToken on an existing session — used by the
 *  reconnect endpoint (POST .../sessions/:id/ws-token) to mint a
 *  fresh single-use token after the old one was consumed.
 *
 *  Returns the row IF the session exists and is owned by the calling
 *  user (caller checks ownership separately; this helper only sets
 *  the hash atomically). */
export async function refreshWsToken(
  db: Database,
  sessionId: string,
  newToken: string,
): Promise<SessionRow | null> {
  const [row] = await db
    .update(nodeTerminalSessions)
    .set({
      wsTokenHash: hashWsToken(newToken),
      wsTokenIssuedAt: new Date(),
    })
    .where(eq(nodeTerminalSessions.id, sessionId))
    .returning();
  if (!row) return null;
  return rowToSession(row);
}

/** Update which replica last attached an exec stream for diagnostics
 *  and stickiness telemetry. Also bumps last_activity_at. */
export async function updateOwnerReplica(
  db: Database,
  sessionId: string,
  ownerReplica: string,
): Promise<void> {
  await db
    .update(nodeTerminalSessions)
    .set({ ownerReplica, lastActivityAt: new Date() })
    .where(eq(nodeTerminalSessions.id, sessionId));
}

/** Touch the activity clock. Batched/throttled by the caller —
 *  hammering this on every stdin keystroke would be wasteful. */
export async function updateActivity(db: Database, sessionId: string): Promise<void> {
  await db
    .update(nodeTerminalSessions)
    .set({ lastActivityAt: new Date() })
    .where(eq(nodeTerminalSessions.id, sessionId));
}

/** Delete a session row. Idempotent. Returns true if a row was
 *  actually removed, false if it was already gone. */
export async function deleteSession(db: Database, sessionId: string): Promise<boolean> {
  const rows = await db
    .delete(nodeTerminalSessions)
    .where(eq(nodeTerminalSessions.id, sessionId))
    .returning({ id: nodeTerminalSessions.id });
  return rows.length > 0;
}

/** Sessions whose lastActivityAt is older than `idleMs` ago. Used by
 *  the cross-replica idle sweeper — any platform-api can now reap
 *  any session, not just one owned locally. */
export async function findIdle(db: Database, idleMs: number): Promise<SessionRow[]> {
  const cutoff = new Date(Date.now() - idleMs);
  const rows = await db
    .select()
    .from(nodeTerminalSessions)
    .where(lt(nodeTerminalSessions.lastActivityAt, cutoff));
  return rows.map(rowToSession);
}

/** Sessions whose expires_at has elapsed. Same cleanup path —
 *  belt-and-braces with k8s activeDeadlineSeconds. */
export async function findExpired(db: Database): Promise<SessionRow[]> {
  const now = new Date();
  const rows = await db
    .select()
    .from(nodeTerminalSessions)
    .where(lt(nodeTerminalSessions.expiresAt, now));
  return rows.map(rowToSession);
}

/** All active sessions for a given node — used by the GET
 *  /admin/nodes/:nodeName/terminal/sessions endpoint. */
export async function listForNode(db: Database, nodeName: string): Promise<SessionRow[]> {
  const rows = await db
    .select()
    .from(nodeTerminalSessions)
    .where(eq(nodeTerminalSessions.nodeName, nodeName));
  return rows.map(rowToSession);
}

/** All active sessions cluster-wide — used by GET
 *  /admin/node-terminal/sessions. */
export async function listAll(db: Database): Promise<SessionRow[]> {
  const rows = await db.select().from(nodeTerminalSessions);
  return rows.map(rowToSession);
}
