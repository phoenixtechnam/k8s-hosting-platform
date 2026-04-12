import { eq, and, desc, count } from 'drizzle-orm';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { sftpUsers, sftpAuditLog, platformSettings } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import type { CreateSftpUserInput, UpdateSftpUserInput } from './schema.js';

const BCRYPT_COST = 12;

// ─── Helpers ───────────────────────────────────────────────────────────────

export function generateSecurePassword(length = 24): string {
  // base64url: 3 bytes -> 4 chars, so generate enough bytes
  const bytes = crypto.randomBytes(Math.ceil((length * 3) / 4));
  return bytes.toString('base64url').slice(0, length);
}

function mapSftpUserToResponse(row: typeof sftpUsers.$inferSelect) {
  return {
    id: row.id,
    clientId: row.clientId,
    username: row.username,
    description: row.description ?? null,
    enabled: row.enabled === 1,
    homePath: row.homePath,
    allowWrite: row.allowWrite === 1,
    allowDelete: row.allowDelete === 1,
    ipWhitelist: row.ipWhitelist ?? null,
    maxConcurrentSessions: row.maxConcurrentSessions,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    lastLoginIp: row.lastLoginIp ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ─── CRUD ──────────────────────────────────────────────────────────────────

export async function listSftpUsers(db: Database, clientId: string, limit = 100) {
  const rows = await db
    .select()
    .from(sftpUsers)
    .where(eq(sftpUsers.clientId, clientId))
    .orderBy(desc(sftpUsers.createdAt))
    .limit(limit);

  return rows.map(mapSftpUserToResponse);
}

export async function getSftpUser(db: Database, clientId: string, userId: string) {
  const [row] = await db
    .select()
    .from(sftpUsers)
    .where(and(eq(sftpUsers.id, userId), eq(sftpUsers.clientId, clientId)));

  if (!row) {
    throw new ApiError('SFTP_USER_NOT_FOUND', `SFTP user '${userId}' not found`, 404);
  }

  return mapSftpUserToResponse(row);
}

export async function createSftpUser(db: Database, clientId: string, input: CreateSftpUserInput) {
  // Check for duplicate username (globally unique)
  const [existing] = await db
    .select()
    .from(sftpUsers)
    .where(eq(sftpUsers.username, input.username));

  if (existing) {
    throw new ApiError('DUPLICATE_SFTP_USERNAME', `SFTP username '${input.username}' is already taken`, 409);
  }

  const plainPassword = generateSecurePassword(24);
  const passwordHash = await bcrypt.hash(plainPassword, BCRYPT_COST);
  const id = crypto.randomUUID();

  await db.insert(sftpUsers).values({
    id,
    clientId,
    username: input.username,
    passwordHash,
    description: input.description ?? null,
    enabled: 1,
    homePath: input.home_path ?? '/',
    allowWrite: input.allow_write === false ? 0 : 1,
    allowDelete: input.allow_delete === true ? 1 : 0,
    ipWhitelist: input.ip_whitelist ?? null,
    maxConcurrentSessions: input.max_concurrent_sessions ?? 3,
    expiresAt: input.expires_at ? new Date(input.expires_at) : null,
  });

  const [created] = await db.select().from(sftpUsers).where(eq(sftpUsers.id, id));
  return { ...mapSftpUserToResponse(created), password: plainPassword };
}

export async function updateSftpUser(
  db: Database,
  clientId: string,
  userId: string,
  input: UpdateSftpUserInput,
) {
  // Verify ownership
  const [existing] = await db
    .select()
    .from(sftpUsers)
    .where(and(eq(sftpUsers.id, userId), eq(sftpUsers.clientId, clientId)));

  if (!existing) {
    throw new ApiError('SFTP_USER_NOT_FOUND', `SFTP user '${userId}' not found`, 404);
  }

  const updates: Record<string, unknown> = {};
  if (input.description !== undefined) updates.description = input.description;
  if (input.enabled !== undefined) updates.enabled = input.enabled ? 1 : 0;
  if (input.home_path !== undefined) updates.homePath = input.home_path;
  if (input.allow_write !== undefined) updates.allowWrite = input.allow_write ? 1 : 0;
  if (input.allow_delete !== undefined) updates.allowDelete = input.allow_delete ? 1 : 0;
  if (input.ip_whitelist !== undefined) updates.ipWhitelist = input.ip_whitelist;
  if (input.max_concurrent_sessions !== undefined) updates.maxConcurrentSessions = input.max_concurrent_sessions;
  if (input.expires_at !== undefined) updates.expiresAt = input.expires_at ? new Date(input.expires_at) : null;

  if (Object.keys(updates).length > 0) {
    await db.update(sftpUsers).set(updates).where(eq(sftpUsers.id, userId));
  }

  const [updated] = await db.select().from(sftpUsers).where(eq(sftpUsers.id, userId));
  return mapSftpUserToResponse(updated);
}

export async function deleteSftpUser(db: Database, clientId: string, userId: string) {
  const [existing] = await db
    .select()
    .from(sftpUsers)
    .where(and(eq(sftpUsers.id, userId), eq(sftpUsers.clientId, clientId)));

  if (!existing) {
    throw new ApiError('SFTP_USER_NOT_FOUND', `SFTP user '${userId}' not found`, 404);
  }

  await db.delete(sftpUsers).where(eq(sftpUsers.id, userId));
}

export async function rotateSftpPassword(
  db: Database,
  clientId: string,
  userId: string,
  customPassword?: string,
) {
  const [existing] = await db
    .select()
    .from(sftpUsers)
    .where(and(eq(sftpUsers.id, userId), eq(sftpUsers.clientId, clientId)));

  if (!existing) {
    throw new ApiError('SFTP_USER_NOT_FOUND', `SFTP user '${userId}' not found`, 404);
  }

  const plainPassword = customPassword ?? generateSecurePassword(24);
  const passwordHash = await bcrypt.hash(plainPassword, BCRYPT_COST);

  await db
    .update(sftpUsers)
    .set({ passwordHash })
    .where(eq(sftpUsers.id, userId));

  return { password: plainPassword };
}

// ─── Connection Info ───────────────────────────────────────────────────────

export async function getSftpConnectionInfo(db: Database) {
  const settings = await db.select().from(platformSettings);
  const settingsMap = new Map(settings.map((s) => [s.key, s.value]));

  const host = settingsMap.get('sftp_gateway_host') ?? 'sftp.platform.local';
  const port = Number(settingsMap.get('sftp_gateway_port') ?? '2222');

  return {
    host,
    port,
    protocols: ['sftp', 'scp', 'rsync'],
    username_format: '<sftp_username>',
    instructions: {
      sftp: `sftp -P ${port} <username>@${host}`,
      scp: `scp -P ${port} file.txt <username>@${host}:/path/`,
      rsync: `rsync -e "ssh -p ${port}" file.txt <username>@${host}:/path/`,
    },
  };
}

// ─── Audit Log ─────────────────────────────────────────────────────────────

export async function listSftpAuditLog(
  db: Database,
  clientId: string,
  limit: number,
  offset: number,
) {
  const [rows, [totalRow]] = await Promise.all([
    db
      .select()
      .from(sftpAuditLog)
      .where(eq(sftpAuditLog.clientId, clientId))
      .orderBy(desc(sftpAuditLog.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: count() })
      .from(sftpAuditLog)
      .where(eq(sftpAuditLog.clientId, clientId)),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      sftpUserId: row.sftpUserId ?? null,
      clientId: row.clientId,
      event: row.event,
      sourceIp: row.sourceIp,
      protocol: row.protocol,
      sessionId: row.sessionId ?? null,
      durationSeconds: row.durationSeconds ?? null,
      bytesTransferred: row.bytesTransferred ? Number(row.bytesTransferred) : null,
      errorMessage: row.errorMessage ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
    total: totalRow?.total ?? 0,
  };
}
