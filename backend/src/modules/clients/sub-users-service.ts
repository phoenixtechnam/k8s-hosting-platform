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
  /**
   * Phase 2: optional — defaults to `client_user`. Callers
   * upstream of the service are responsible for enforcing that
   * only authorized roles (client_admin + staff) can request a
   * `client_admin` sub-user.
   */
  readonly role_name?: 'client_admin' | 'client_user';
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

export interface UpdateSubUserPayload {
  readonly fullName?: string;
  readonly roleName?: 'client_admin' | 'client_user';
  readonly status?: 'active' | 'disabled';
}

/**
 * Narrow db interface the service depends on. Allows tests to
 * pass a tiny in-memory stub instead of mocking all of Drizzle.
 *
 * `runInTransaction` exists to close the Phase 3 last-admin guard
 * TOCTOU race: the service wraps its check+update inside a single
 * transaction so a concurrent request cannot pass the check and
 * then race through the update. The in-memory test stub just
 * invokes the callback with `this` — tests are single-threaded
 * so there's nothing to lock — but the production Drizzle adapter
 * uses `db.transaction()` which takes a row-level lock implicitly
 * via `SERIALIZABLE` isolation (Postgres default: read-committed,
 * but the transaction scope is enough to make the check+update
 * atomic against other transactions committing between them).
 */
export interface SubUsersDb {
  listByClientId(clientId: string): Promise<readonly SubUserDto[]>;
  countByClientId(clientId: string): Promise<number>;
  countAdminsByClientId(clientId: string): Promise<number>;
  countActiveAdminsByClientId(clientId: string): Promise<number>;
  findByIdAndClientId(
    userId: string,
    clientId: string,
  ): Promise<{ readonly id: string; readonly roleName: string; readonly status: string } | null>;
  insertSubUser(payload: InsertSubUserPayload): Promise<CreatedSubUserDto>;
  updateSubUser(
    userId: string,
    clientId: string,
    payload: UpdateSubUserPayload,
  ): Promise<SubUserDto>;
  updatePasswordHash(
    userId: string,
    clientId: string,
    passwordHash: string,
  ): Promise<void>;
  deleteById(userId: string, clientId: string): Promise<void>;
  runInTransaction<T>(fn: (tx: SubUsersDb) => Promise<T>): Promise<T>;
}

// ─── Service functions ─────────────────────────────────────────────────────

/**
 * Closed set of roles the service is willing to write for a
 * client-panel sub-user. This is the service's self-defense
 * against callers that bypass the route-level Zod parse (e.g.
 * scripts, future internal callers). Changing this set also
 * requires updating `subUserRoleSchema` in
 * `@k8s-hosting/api-contracts` so the HTTP surface stays in sync.
 */
const ALLOWED_SUB_USER_ROLES = ['client_admin', 'client_user'] as const;
type AllowedSubUserRole = typeof ALLOWED_SUB_USER_ROLES[number];

function isAllowedRole(role: string): role is AllowedSubUserRole {
  return (ALLOWED_SUB_USER_ROLES as readonly string[]).includes(role);
}

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

  const roleName = input.role_name ?? 'client_user';
  if (!isAllowedRole(roleName)) {
    // Defense in depth — the route layer's Zod parse should have
    // already rejected this, but we refuse to persist an unknown
    // role at the service boundary too.
    throw new ApiError(
      'INVALID_FIELD_VALUE',
      `role_name must be one of: ${ALLOWED_SUB_USER_ROLES.join(', ')}`,
      400,
      { field: 'role_name' },
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
    roleName,
    clientId,
  });
}

export async function deleteSubUser(
  db: SubUsersDb,
  clientId: string,
  userId: string,
): Promise<void> {
  // Wrap the check+delete in a single transaction so a concurrent
  // request cannot race between the admin count check and the
  // delete, leaving the client with zero admins.
  await db.runInTransaction(async (tx) => {
    const user = await tx.findByIdAndClientId(userId, clientId);
    if (!user) {
      throw new ApiError('USER_NOT_FOUND', 'User not found', 404);
    }

    // Don't allow deleting the last client_admin
    if (user.roleName === 'client_admin') {
      const adminCount = await tx.countAdminsByClientId(clientId);
      if (adminCount <= 1) {
        throw new ApiError('LAST_ADMIN', 'Cannot delete the last client admin', 403);
      }
    }

    await tx.deleteById(userId, clientId);
  });
}

/**
 * Update a sub-user's name, role, or status. Enforces:
 *   - User exists and belongs to this client
 *   - Can't demote the last active client_admin to client_user
 *   - Can't disable the last active client_admin
 *   - Role change validates against the ALLOWED_SUB_USER_ROLES set
 *
 * Password changes are not accepted here — Phase 4 adds a dedicated
 * reset-password endpoint.
 */
export async function updateSubUser(
  db: SubUsersDb,
  clientId: string,
  userId: string,
  input: UpdateSubUserPayload,
): Promise<SubUserDto> {
  // Defense-in-depth: validate role BEFORE opening a transaction
  // so a bad request doesn't burn a transaction slot.
  if (input.roleName !== undefined && !isAllowedRole(input.roleName)) {
    throw new ApiError(
      'INVALID_FIELD_VALUE',
      `role_name must be one of: ${ALLOWED_SUB_USER_ROLES.join(', ')}`,
      400,
      { field: 'role_name' },
    );
  }

  // Wrap the check+update in a single transaction so a concurrent
  // request cannot pass the last-admin guard and race through the
  // update, leaving the client with zero active admins.
  return db.runInTransaction(async (tx) => {
    const existing = await tx.findByIdAndClientId(userId, clientId);
    if (!existing) {
      throw new ApiError('USER_NOT_FOUND', 'User not found', 404);
    }

    // Last-admin protection: refuse to demote or disable the sole
    // active client_admin, which would leave the client locked out.
    const wouldDemoteFromAdmin =
      existing.roleName === 'client_admin'
      && input.roleName !== undefined
      && input.roleName !== 'client_admin';
    const wouldDisableAdmin =
      existing.roleName === 'client_admin'
      && existing.status === 'active'
      && input.status === 'disabled';

    if (wouldDemoteFromAdmin || wouldDisableAdmin) {
      const activeAdminCount = await tx.countActiveAdminsByClientId(clientId);
      if (activeAdminCount <= 1) {
        throw new ApiError(
          'LAST_ADMIN',
          wouldDemoteFromAdmin
            ? 'Cannot demote the last active client admin'
            : 'Cannot disable the last active client admin',
          403,
        );
      }
    }

    return tx.updateSubUser(userId, clientId, {
      fullName: input.fullName,
      roleName: input.roleName,
      status: input.status,
    });
  });
}

/**
 * Phase 4: admin-assisted password reset. Hashes the new password
 * with bcrypt and writes it to the users row. Verifies the user
 * belongs to the client before writing.
 *
 * Does NOT send email or notify the user — the caller is
 * responsible for communicating the new password out-of-band.
 * Does NOT invalidate existing JWTs — Phase 9 will address session
 * invalidation when the sessions table lands.
 */
export async function resetSubUserPassword(
  db: SubUsersDb,
  clientId: string,
  userId: string,
  newPassword: string,
): Promise<void> {
  if (!newPassword || newPassword.length < 8) {
    throw new ApiError(
      'INVALID_FIELD_VALUE',
      'new_password must be at least 8 characters',
      400,
      { field: 'new_password' },
    );
  }

  const existing = await db.findByIdAndClientId(userId, clientId);
  if (!existing) {
    throw new ApiError('USER_NOT_FOUND', 'User not found', 404);
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await db.updatePasswordHash(userId, clientId, passwordHash);
}

// ─── Production Drizzle adapter ────────────────────────────────────────────

/**
 * Wraps the real `Database` into a `SubUsersDb` so route handlers
 * can call `listSubUsers(makeDrizzleSubUsersDb(app.db), clientId)`.
 */
/**
 * `Database`-compatible transactional context. Drizzle's transaction
 * callback receives a `tx` parameter that implements the same query
 * interface as `Database`, so we can pass it straight into
 * `makeDrizzleSubUsersDb(tx)` to get a transaction-scoped adapter.
 */
type DbOrTx = Database;

function buildAdapter(db: DbOrTx): SubUsersDb {
  // Phase 1 hardening: every read scopes to `panel = 'client'` so an
  // admin-panel user whose `clientId` column happens to equal the
  // URL-param clientId can never leak into the client-visible team
  // list. Writes always carry both clientId and panel filters so a
  // mismatched caller can't mutate rows outside the intended scope.
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
    async countActiveAdminsByClientId(clientId) {
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.clientId, clientId),
            eq(users.panel, 'client'),
            eq(users.roleName, 'client_admin'),
            eq(users.status, 'active'),
          ),
        );
      return rows.length;
    },
    async findByIdAndClientId(userId, clientId) {
      const [row] = await db
        .select({
          id: users.id,
          roleName: users.roleName,
          status: users.status,
        })
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
    async updateSubUser(userId, clientId, payload) {
      const updates: {
        fullName?: string;
        roleName?: string;
        status?: 'active' | 'disabled';
      } = {};
      if (payload.fullName !== undefined) updates.fullName = payload.fullName;
      if (payload.roleName !== undefined) updates.roleName = payload.roleName;
      if (payload.status !== undefined) updates.status = payload.status;

      const [updated] = await db
        .update(users)
        .set(updates)
        .where(and(eq(users.id, userId), clientUserScope(clientId)))
        .returning({
          id: users.id,
          email: users.email,
          fullName: users.fullName,
          roleName: users.roleName,
          status: users.status,
          createdAt: users.createdAt,
          lastLoginAt: users.lastLoginAt,
        });
      return updated;
    },
    async updatePasswordHash(userId, clientId, passwordHash) {
      await db
        .update(users)
        .set({ passwordHash })
        .where(and(eq(users.id, userId), clientUserScope(clientId)));
    },
    async deleteById(userId, clientId) {
      await db
        .delete(users)
        .where(and(eq(users.id, userId), clientUserScope(clientId)));
    },
    async runInTransaction(fn) {
      return db.transaction(async (tx) => fn(buildAdapter(tx as unknown as Database)));
    },
  };
}

export function makeDrizzleSubUsersDb(db: Database): SubUsersDb {
  return buildAdapter(db);
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
