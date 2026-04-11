/**
 * Protected directory CRUD + directory-scoped auth user management.
 *
 * Each ingress route can have multiple protected directories, each with
 * its own path, realm, and set of basic-auth users.
 */

import { eq, and, sql } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { routeProtectedDirs, routeAuthUsers, ingressRoutes, domains } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';

const SALT_ROUNDS = 10;

// ─── Helpers ────────────────────────────────────────────────────────────────

async function verifyRouteOwnership(db: Database, routeId: string, clientId: string) {
  const [route] = await db.select().from(ingressRoutes).where(eq(ingressRoutes.id, routeId));
  if (!route) {
    throw new ApiError('ROUTE_NOT_FOUND', `Ingress route '${routeId}' not found`, 404);
  }

  const [domain] = await db
    .select()
    .from(domains)
    .where(and(eq(domains.id, route.domainId), eq(domains.clientId, clientId)));

  if (!domain) {
    throw new ApiError('ROUTE_NOT_FOUND', `Ingress route '${routeId}' not found for client`, 404);
  }

  return route;
}

async function getDirOrThrow(db: Database, dirId: string) {
  const [dir] = await db.select().from(routeProtectedDirs).where(eq(routeProtectedDirs.id, dirId));
  if (!dir) {
    throw new ApiError('PROTECTED_DIR_NOT_FOUND', `Protected directory '${dirId}' not found`, 404);
  }
  return dir;
}

async function verifyDirOwnership(db: Database, dirId: string, routeId: string, clientId: string) {
  await verifyRouteOwnership(db, routeId, clientId);
  const dir = await getDirOrThrow(db, dirId);
  if (dir.routeId !== routeId) {
    throw new ApiError('PROTECTED_DIR_NOT_FOUND', `Protected directory '${dirId}' not found on route`, 404);
  }
  return dir;
}

function validatePath(path: string) {
  if (!path.startsWith('/')) {
    throw new ApiError('VALIDATION_ERROR', 'Path must start with /', 400);
  }
  if (path.includes('..')) {
    throw new ApiError('VALIDATION_ERROR', 'Path must not contain ..', 400);
  }
  if (path.length > 255) {
    throw new ApiError('VALIDATION_ERROR', 'Path must be at most 255 characters', 400);
  }
}

function mapDirToResponse(dir: typeof routeProtectedDirs.$inferSelect, userCount: number) {
  return {
    id: dir.id,
    routeId: dir.routeId,
    path: dir.path,
    realm: dir.realm,
    enabled: Boolean(dir.enabled),
    userCount,
    createdAt: dir.createdAt?.toISOString?.() ?? String(dir.createdAt),
  };
}

// ─── Protected Directory CRUD ───────────────────────────────────────────────

export async function listProtectedDirs(db: Database, routeId: string) {
  const dirs = await db
    .select()
    .from(routeProtectedDirs)
    .where(eq(routeProtectedDirs.routeId, routeId));

  // Fetch user counts for each dir
  const results = await Promise.all(
    dirs.map(async (dir) => {
      const [countRow] = await db
        .select({ count: sql<number>`count(*)` })
        .from(routeAuthUsers)
        .where(eq(routeAuthUsers.dirId, dir.id));
      return mapDirToResponse(dir, Number(countRow?.count ?? 0));
    }),
  );

  return results;
}

export async function createProtectedDir(
  db: Database,
  routeId: string,
  clientId: string,
  input: { path: string; realm?: string },
) {
  await verifyRouteOwnership(db, routeId, clientId);
  validatePath(input.path);

  // Check uniqueness: path per route
  const [existing] = await db
    .select({ id: routeProtectedDirs.id })
    .from(routeProtectedDirs)
    .where(and(eq(routeProtectedDirs.routeId, routeId), eq(routeProtectedDirs.path, input.path)));

  if (existing) {
    throw new ApiError('PROTECTED_DIR_EXISTS', `Path '${input.path}' already protected on this route`, 409);
  }

  const id = crypto.randomUUID();
  await db.insert(routeProtectedDirs).values({
    id,
    routeId,
    path: input.path,
    realm: input.realm ?? 'Restricted',
  });

  const [created] = await db.select().from(routeProtectedDirs).where(eq(routeProtectedDirs.id, id));
  return mapDirToResponse(created, 0);
}

export async function updateProtectedDir(
  db: Database,
  dirId: string,
  routeId: string,
  clientId: string,
  input: { path?: string; realm?: string; enabled?: boolean },
) {
  await verifyDirOwnership(db, dirId, routeId, clientId);

  const updateValues: Record<string, unknown> = {};
  if (input.path !== undefined) {
    validatePath(input.path);
    // Check uniqueness for the new path (excluding self)
    const [dup] = await db
      .select({ id: routeProtectedDirs.id })
      .from(routeProtectedDirs)
      .where(
        and(
          eq(routeProtectedDirs.routeId, routeId),
          eq(routeProtectedDirs.path, input.path),
        ),
      );
    if (dup && dup.id !== dirId) {
      throw new ApiError('PROTECTED_DIR_EXISTS', `Path '${input.path}' already protected on this route`, 409);
    }
    updateValues.path = input.path;
  }
  if (input.realm !== undefined) updateValues.realm = input.realm;
  if (input.enabled !== undefined) updateValues.enabled = input.enabled ? 1 : 0;

  if (Object.keys(updateValues).length > 0) {
    await db.update(routeProtectedDirs).set(updateValues).where(eq(routeProtectedDirs.id, dirId));
  }

  const [updated] = await db.select().from(routeProtectedDirs).where(eq(routeProtectedDirs.id, dirId));
  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(routeAuthUsers)
    .where(eq(routeAuthUsers.dirId, dirId));

  return mapDirToResponse(updated, Number(countRow?.count ?? 0));
}

export async function deleteProtectedDir(
  db: Database,
  dirId: string,
  routeId: string,
  clientId: string,
) {
  await verifyDirOwnership(db, dirId, routeId, clientId);
  // CASCADE will remove child auth users
  await db.delete(routeProtectedDirs).where(eq(routeProtectedDirs.id, dirId));
}

// ─── Directory-Scoped Auth User CRUD ────────────────────────────────────────

export async function listDirUsers(db: Database, dirId: string) {
  const users = await db
    .select({
      id: routeAuthUsers.id,
      dirId: routeAuthUsers.dirId,
      username: routeAuthUsers.username,
      enabled: routeAuthUsers.enabled,
      createdAt: routeAuthUsers.createdAt,
    })
    .from(routeAuthUsers)
    .where(eq(routeAuthUsers.dirId, dirId));

  return users.map((u) => ({
    ...u,
    enabled: Boolean(u.enabled),
    createdAt: u.createdAt?.toISOString?.() ?? String(u.createdAt),
  }));
}

export async function createDirUser(
  db: Database,
  dirId: string,
  username: string,
  password: string,
) {
  // Check for duplicate username on this dir
  const [existing] = await db
    .select({ id: routeAuthUsers.id })
    .from(routeAuthUsers)
    .where(and(eq(routeAuthUsers.dirId, dirId), eq(routeAuthUsers.username, username)));

  if (existing) {
    throw new ApiError('AUTH_USER_EXISTS', `User '${username}' already exists in this directory`, 409);
  }

  const id = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  await db.insert(routeAuthUsers).values({
    id,
    dirId,
    username,
    passwordHash,
  });

  const [created] = await db
    .select({
      id: routeAuthUsers.id,
      dirId: routeAuthUsers.dirId,
      username: routeAuthUsers.username,
      enabled: routeAuthUsers.enabled,
      createdAt: routeAuthUsers.createdAt,
    })
    .from(routeAuthUsers)
    .where(eq(routeAuthUsers.id, id));

  return {
    ...created,
    enabled: Boolean(created.enabled),
    createdAt: created.createdAt?.toISOString?.() ?? String(created.createdAt),
  };
}

export async function deleteDirUser(db: Database, dirId: string, userId: string) {
  const [user] = await db
    .select()
    .from(routeAuthUsers)
    .where(and(eq(routeAuthUsers.id, userId), eq(routeAuthUsers.dirId, dirId)));

  if (!user) {
    throw new ApiError('AUTH_USER_NOT_FOUND', `Auth user '${userId}' not found in directory`, 404);
  }

  await db.delete(routeAuthUsers).where(eq(routeAuthUsers.id, userId));
}

export async function toggleDirUser(
  db: Database,
  dirId: string,
  userId: string,
  enabled: boolean,
) {
  const [user] = await db
    .select()
    .from(routeAuthUsers)
    .where(and(eq(routeAuthUsers.id, userId), eq(routeAuthUsers.dirId, dirId)));

  if (!user) {
    throw new ApiError('AUTH_USER_NOT_FOUND', `Auth user '${userId}' not found in directory`, 404);
  }

  await db
    .update(routeAuthUsers)
    .set({ enabled: enabled ? 1 : 0 })
    .where(eq(routeAuthUsers.id, userId));
}

export async function changeDirUserPassword(
  db: Database,
  dirId: string,
  userId: string,
  newPassword: string,
) {
  const [user] = await db
    .select()
    .from(routeAuthUsers)
    .where(and(eq(routeAuthUsers.id, userId), eq(routeAuthUsers.dirId, dirId)));

  if (!user) {
    throw new ApiError('AUTH_USER_NOT_FOUND', `Auth user '${userId}' not found in directory`, 404);
  }

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await db.update(routeAuthUsers).set({ passwordHash }).where(eq(routeAuthUsers.id, userId));
}
