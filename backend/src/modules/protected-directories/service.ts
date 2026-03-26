import { eq, and } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { protectedDirectories, protectedDirectoryUsers, domains } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import type { CreateProtectedDirectoryInput, UpdateProtectedDirectoryInput, CreateProtectedDirectoryUserInput } from './schema.js';

const SALT_ROUNDS = 10;

async function verifyDomainOwnership(db: Database, clientId: string, domainId: string) {
  const [domain] = await db
    .select()
    .from(domains)
    .where(and(eq(domains.id, domainId), eq(domains.clientId, clientId)));

  if (!domain) {
    throw new ApiError('DOMAIN_NOT_FOUND', `Domain '${domainId}' not found for client`, 404);
  }
  return domain;
}

async function getDirectoryOrThrow(db: Database, domainId: string, dirId: string) {
  const [dir] = await db
    .select()
    .from(protectedDirectories)
    .where(and(eq(protectedDirectories.id, dirId), eq(protectedDirectories.domainId, domainId)));

  if (!dir) {
    throw new ApiError('PROTECTED_DIR_NOT_FOUND', `Protected directory '${dirId}' not found`, 404);
  }
  return dir;
}

// ─── Directory CRUD ─────────────────────────────────────────────────────────

export async function listDirectories(db: Database, clientId: string, domainId: string) {
  await verifyDomainOwnership(db, clientId, domainId);
  return db.select().from(protectedDirectories).where(eq(protectedDirectories.domainId, domainId));
}

export async function getDirectory(db: Database, clientId: string, domainId: string, dirId: string) {
  await verifyDomainOwnership(db, clientId, domainId);
  return getDirectoryOrThrow(db, domainId, dirId);
}

export async function createDirectory(
  db: Database, clientId: string, domainId: string, input: CreateProtectedDirectoryInput,
) {
  await verifyDomainOwnership(db, clientId, domainId);

  const id = crypto.randomUUID();
  await db.insert(protectedDirectories).values({
    id,
    domainId,
    path: input.path,
    realm: input.realm ?? 'Restricted Area',
  });

  const [created] = await db.select().from(protectedDirectories).where(eq(protectedDirectories.id, id));
  return created;
}

export async function updateDirectory(
  db: Database, clientId: string, domainId: string, dirId: string, input: UpdateProtectedDirectoryInput,
) {
  await verifyDomainOwnership(db, clientId, domainId);
  await getDirectoryOrThrow(db, domainId, dirId);

  if (input.realm !== undefined) {
    await db.update(protectedDirectories).set({ realm: input.realm }).where(eq(protectedDirectories.id, dirId));
  }

  const [updated] = await db.select().from(protectedDirectories).where(eq(protectedDirectories.id, dirId));
  return updated;
}

export async function deleteDirectory(db: Database, clientId: string, domainId: string, dirId: string) {
  await verifyDomainOwnership(db, clientId, domainId);
  await getDirectoryOrThrow(db, domainId, dirId);

  await db.delete(protectedDirectoryUsers).where(eq(protectedDirectoryUsers.directoryId, dirId));
  await db.delete(protectedDirectories).where(eq(protectedDirectories.id, dirId));
}

// ─── Directory User CRUD ────────────────────────────────────────────────────

export async function listDirectoryUsers(db: Database, clientId: string, domainId: string, dirId: string) {
  await verifyDomainOwnership(db, clientId, domainId);
  await getDirectoryOrThrow(db, domainId, dirId);

  const users = await db
    .select({
      id: protectedDirectoryUsers.id,
      directoryId: protectedDirectoryUsers.directoryId,
      username: protectedDirectoryUsers.username,
      enabled: protectedDirectoryUsers.enabled,
      createdAt: protectedDirectoryUsers.createdAt,
    })
    .from(protectedDirectoryUsers)
    .where(eq(protectedDirectoryUsers.directoryId, dirId));

  return users.map((u) => ({ ...u, enabled: Boolean(u.enabled) }));
}

export async function createDirectoryUser(
  db: Database, clientId: string, domainId: string, dirId: string, input: CreateProtectedDirectoryUserInput,
) {
  await verifyDomainOwnership(db, clientId, domainId);
  await getDirectoryOrThrow(db, domainId, dirId);

  const id = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

  await db.insert(protectedDirectoryUsers).values({
    id,
    directoryId: dirId,
    username: input.username,
    passwordHash,
  });

  const [created] = await db
    .select({
      id: protectedDirectoryUsers.id,
      directoryId: protectedDirectoryUsers.directoryId,
      username: protectedDirectoryUsers.username,
      enabled: protectedDirectoryUsers.enabled,
      createdAt: protectedDirectoryUsers.createdAt,
    })
    .from(protectedDirectoryUsers)
    .where(eq(protectedDirectoryUsers.id, id));

  return { ...created, enabled: Boolean(created.enabled) };
}

export async function changeDirectoryUserPassword(
  db: Database, clientId: string, domainId: string, dirId: string, userId: string, password: string,
) {
  await verifyDomainOwnership(db, clientId, domainId);
  await getDirectoryOrThrow(db, domainId, dirId);

  const [user] = await db
    .select()
    .from(protectedDirectoryUsers)
    .where(and(eq(protectedDirectoryUsers.id, userId), eq(protectedDirectoryUsers.directoryId, dirId)));

  if (!user) {
    throw new ApiError('DIR_USER_NOT_FOUND', `User '${userId}' not found in directory`, 404);
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  await db.update(protectedDirectoryUsers).set({ passwordHash }).where(eq(protectedDirectoryUsers.id, userId));
}

export async function toggleDirectoryUser(
  db: Database, clientId: string, domainId: string, dirId: string, userId: string, enabled: boolean,
) {
  await verifyDomainOwnership(db, clientId, domainId);
  await getDirectoryOrThrow(db, domainId, dirId);

  const [user] = await db
    .select()
    .from(protectedDirectoryUsers)
    .where(and(eq(protectedDirectoryUsers.id, userId), eq(protectedDirectoryUsers.directoryId, dirId)));

  if (!user) {
    throw new ApiError('DIR_USER_NOT_FOUND', `User '${userId}' not found in directory`, 404);
  }

  await db.update(protectedDirectoryUsers).set({ enabled: enabled ? 1 : 0 }).where(eq(protectedDirectoryUsers.id, userId));
}

export async function deleteDirectoryUser(
  db: Database, clientId: string, domainId: string, dirId: string, userId: string,
) {
  await verifyDomainOwnership(db, clientId, domainId);
  await getDirectoryOrThrow(db, domainId, dirId);

  const [user] = await db
    .select()
    .from(protectedDirectoryUsers)
    .where(and(eq(protectedDirectoryUsers.id, userId), eq(protectedDirectoryUsers.directoryId, dirId)));

  if (!user) {
    throw new ApiError('DIR_USER_NOT_FOUND', `User '${userId}' not found in directory`, 404);
  }

  await db.delete(protectedDirectoryUsers).where(eq(protectedDirectoryUsers.id, userId));
}
