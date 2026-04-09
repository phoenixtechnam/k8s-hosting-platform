import { eq, and } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { users, hostingPlans, clients } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';

/**
 * Phase 1: extracted sub-users service.
 *
 * Before extraction, the sub-user routes made raw Drizzle calls
 * via `app.db` which made them impossible to unit-test without a
 * real database. The routes layer now delegates to these pure
 * functions, and tests can inject a minimal `SubUsersDb` stub.
 *
 * The production `makeDrizzleSubUsersDb(db)` adapter bridges the
 * stub interface to the real Drizzle queries — the route handlers
 * import that factory so the public call-site stays a single line.
 */

// ─── Public types ───────────────────────────────────────────────────────────

export interface SubUserDto {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly roleName: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly lastLoginAt: Date | null;
}

export interface CreatedSubUserDto {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly roleName: string;
  readonly status: string;
  readonly createdAt: Date;
}

export interface CreateSubUserInput {
  readonly email: string;
  readonly full_name: string;
  readonly password: string;
}

export interface CreateSubUserOptions {
  /**
   * Max sub-users allowed for this client (from hosting plan +
   * per-client override). Service enforces `< maxSubUsers`. If
   * omitted the service skips the check (callers are expected to
   * pass this in production — the default is `Infinity`).
   */
  readonly maxSubUsers?: number;
}

export interface InsertSubUserPayload {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly fullName: string;
  readonly roleName: string;
  readonly clientId: string;
}

/**
 * Narrow db interface the service depends on. Allows tests to
 * pass a tiny in-memory stub instead of mocking all of Drizzle.
 */
export interface SubUsersDb {
  listByClientId(clientId: string): Promise<readonly SubUserDto[]>;
  countByClientId(clientId: string): Promise<number>;
  countAdminsByClientId(clientId: string): Promise<number>;
  findByIdAndClientId(
    userId: string,
    clientId: string,
  ): Promise<{ readonly id: string; readonly roleName: string } | null>;
  insertSubUser(payload: InsertSubUserPayload): Promise<CreatedSubUserDto>;
  deleteById(userId: string): Promise<void>;
}

// ─── Service functions ─────────────────────────────────────────────────────

export async function listSubUsers(
  db: SubUsersDb,
  clientId: string,
): Promise<readonly SubUserDto[]> {
  return db.listByClientId(clientId);
}

export async function createSubUser(
  db: SubUsersDb,
  clientId: string,
  input: CreateSubUserInput,
  options: CreateSubUserOptions = {},
): Promise<CreatedSubUserDto> {
  if (!input.email || !input.full_name || !input.password) {
    throw new ApiError(
      'MISSING_REQUIRED_FIELD',
      'email, full_name, and password are required',
      400,
    );
  }

  const max = options.maxSubUsers ?? Number.POSITIVE_INFINITY;
  const existing = await db.countByClientId(clientId);
  if (existing >= max) {
    throw new ApiError(
      'SUB_USER_LIMIT',
      `Maximum ${max} users allowed for this plan`,
      403,
      { limit: max, current: existing },
    );
  }

  const passwordHash = await bcrypt.hash(input.password, 12);
  const id = crypto.randomUUID();

  return db.insertSubUser({
    id,
    email: input.email,
    passwordHash,
    fullName: input.full_name,
    roleName: 'client_user',
    clientId,
  });
}

export async function deleteSubUser(
  db: SubUsersDb,
  clientId: string,
  userId: string,
): Promise<void> {
  const user = await db.findByIdAndClientId(userId, clientId);
  if (!user) {
    throw new ApiError('USER_NOT_FOUND', 'User not found', 404);
  }

  // Don't allow deleting the last client_admin
  if (user.roleName === 'client_admin') {
    const adminCount = await db.countAdminsByClientId(clientId);
    if (adminCount <= 1) {
      throw new ApiError('LAST_ADMIN', 'Cannot delete the last client admin', 403);
    }
  }

  await db.deleteById(userId);
}

// ─── Production Drizzle adapter ────────────────────────────────────────────

/**
 * Wraps the real `Database` into a `SubUsersDb` so route handlers
 * can call `listSubUsers(makeDrizzleSubUsersDb(app.db), clientId)`.
 */
export function makeDrizzleSubUsersDb(db: Database): SubUsersDb {
  // Phase 1 hardening: every read scopes to `panel = 'client'` so an
  // admin-panel user whose `clientId` column happens to equal the
  // URL-param clientId can never leak into the client-visible team
  // list. Writes already set panel='client' explicitly.
  const clientUserScope = (clientId: string) =>
    and(eq(users.clientId, clientId), eq(users.panel, 'client'));

  return {
    async listByClientId(clientId) {
      return db
        .select({
          id: users.id,
          email: users.email,
          fullName: users.fullName,
          roleName: users.roleName,
          status: users.status,
          createdAt: users.createdAt,
          lastLoginAt: users.lastLoginAt,
        })
        .from(users)
        .where(clientUserScope(clientId));
    },
    async countByClientId(clientId) {
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(clientUserScope(clientId));
      return rows.length;
    },
    async countAdminsByClientId(clientId) {
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.clientId, clientId),
            eq(users.panel, 'client'),
            eq(users.roleName, 'client_admin'),
          ),
        );
      return rows.length;
    },
    async findByIdAndClientId(userId, clientId) {
      const [row] = await db
        .select({ id: users.id, roleName: users.roleName })
        .from(users)
        .where(
          and(
            eq(users.id, userId),
            eq(users.clientId, clientId),
            eq(users.panel, 'client'),
          ),
        );
      return row ?? null;
    },
    async insertSubUser(payload) {
      // Phase 1: use `.returning()` to atomically get the created
      // row in one round-trip instead of insert+select.
      const [created] = await db
        .insert(users)
        .values({
          id: payload.id,
          email: payload.email,
          passwordHash: payload.passwordHash,
          fullName: payload.fullName,
          roleName: payload.roleName,
          panel: 'client',
          clientId: payload.clientId,
          status: 'active',
          emailVerifiedAt: new Date(),
        })
        .returning({
          id: users.id,
          email: users.email,
          fullName: users.fullName,
          roleName: users.roleName,
          status: users.status,
          createdAt: users.createdAt,
        });
      return created;
    },
    async deleteById(userId) {
      await db.delete(users).where(eq(users.id, userId));
    },
  };
}

/**
 * Look up the effective max sub-user limit for a client:
 * `clients.maxSubUsersOverride` if set, otherwise
 * `hostingPlans.maxSubUsers` for the client's plan. Falls back
 * to `10` if neither is present (matches the previous hardcoded
 * behavior for safety).
 */
export async function getEffectiveMaxSubUsers(
  db: Database,
  clientId: string,
): Promise<number> {
  const [row] = await db
    .select({
      override: clients.maxSubUsersOverride,
      planMax: hostingPlans.maxSubUsers,
    })
    .from(clients)
    .leftJoin(hostingPlans, eq(clients.planId, hostingPlans.id))
    .where(eq(clients.id, clientId));

  if (!row) return 10;
  return row.override ?? row.planMax ?? 10;
}
