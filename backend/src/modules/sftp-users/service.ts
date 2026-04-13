import { eq, and, desc, count, inArray } from 'drizzle-orm';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { sftpUsers, sftpAuditLog, sftpUserSshKeys, sshKeys, platformSettings } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import type { CreateSftpUserInput, UpdateSftpUserInput } from './schema.js';

const BCRYPT_COST = 12;
const HOME_PATH_REGEX = /^[a-zA-Z0-9/_.-]*$/;

// ─── Helpers ───────────────────────────────────────────────────────────────

function validateHomePath(path: string): void {
  if (path.includes('..')) {
    throw new ApiError('INVALID_HOME_PATH', 'home_path must not contain ".."', 400);
  }
  if (!HOME_PATH_REGEX.test(path)) {
    throw new ApiError('INVALID_HOME_PATH', 'home_path contains invalid characters — only alphanumeric, /, _, ., and - are allowed', 400);
  }
}

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

async function fetchLinkedSshKeys(db: Database, userIds: string[]) {
  if (userIds.length === 0) return new Map<string, Array<{ id: string; name: string }>>();

  const links = await db
    .select({
      sftpUserId: sftpUserSshKeys.sftpUserId,
      sshKeyId: sshKeys.id,
      sshKeyName: sshKeys.name,
    })
    .from(sftpUserSshKeys)
    .innerJoin(sshKeys, eq(sftpUserSshKeys.sshKeyId, sshKeys.id))
    .where(inArray(sftpUserSshKeys.sftpUserId, userIds));

  const map = new Map<string, Array<{ id: string; name: string }>>();
  for (const link of links) {
    const existing = map.get(link.sftpUserId) ?? [];
    existing.push({ id: link.sshKeyId, name: link.sshKeyName });
    map.set(link.sftpUserId, existing);
  }
  return map;
}

export async function listSftpUsers(db: Database, clientId: string, limit = 100) {
  const rows = await db
    .select()
    .from(sftpUsers)
    .where(eq(sftpUsers.clientId, clientId))
    .orderBy(desc(sftpUsers.createdAt))
    .limit(limit);

  const userIds = rows.map((r) => r.id);
  const linkedKeysMap = await fetchLinkedSshKeys(db, userIds);

  return rows.map((row) => ({
    ...mapSftpUserToResponse(row),
    linkedSshKeys: linkedKeysMap.get(row.id) ?? [],
  }));
}

export async function getSftpUser(db: Database, clientId: string, userId: string) {
  const [row] = await db
    .select()
    .from(sftpUsers)
    .where(and(eq(sftpUsers.id, userId), eq(sftpUsers.clientId, clientId)));

  if (!row) {
    throw new ApiError('SFTP_USER_NOT_FOUND', `SFTP user '${userId}' not found`, 404);
  }

  const linkedKeysMap = await fetchLinkedSshKeys(db, [row.id]);

  return {
    ...mapSftpUserToResponse(row),
    linkedSshKeys: linkedKeysMap.get(row.id) ?? [],
  };
}

function generateUsername(): string {
  return crypto.randomBytes(4).toString('hex'); // 8 hex chars, e.g. "a3f7c2e1"
}

export async function createSftpUser(db: Database, clientId: string, input: CreateSftpUserInput) {
  // Validate home_path at the service layer (defense-in-depth beyond Zod)
  if (input.home_path) {
    validateHomePath(input.home_path);
  }

  const authMethod = input.auth_method;

  // SSH key auth requires at least one key
  if (authMethod === 'ssh_key') {
    if (!input.ssh_key_ids || input.ssh_key_ids.length === 0) {
      throw new ApiError('SSH_KEYS_REQUIRED', 'At least one SSH key is required when using ssh_key auth method', 400);
    }
  }

  // Auto-generate a unique 8-char hex username (clients cannot choose)
  let username = generateUsername();
  for (let attempt = 0; attempt < 5; attempt++) {
    const [existing] = await db
      .select()
      .from(sftpUsers)
      .where(eq(sftpUsers.username, username));
    if (!existing) break;
    username = generateUsername();
  }

  const id = crypto.randomUUID();

  // Password auth: generate password; SSH key auth: no password
  let plainPassword: string | undefined;
  let passwordHash: string | null = null;
  if (authMethod === 'password') {
    plainPassword = generateSecurePassword(24);
    passwordHash = await bcrypt.hash(plainPassword, BCRYPT_COST);
  }

  await db.insert(sftpUsers).values({
    id,
    clientId,
    username,
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

  // Link SSH keys to this SFTP user
  if (authMethod === 'ssh_key' && input.ssh_key_ids) {
    for (const sshKeyId of input.ssh_key_ids) {
      await db.insert(sftpUserSshKeys).values({
        id: crypto.randomUUID(),
        sftpUserId: id,
        sshKeyId,
      });
    }
  }

  const [created] = await db.select().from(sftpUsers).where(eq(sftpUsers.id, id));
  const response = mapSftpUserToResponse(created);

  // Only include password for password-based auth
  if (authMethod === 'password' && plainPassword) {
    return { ...response, password: plainPassword };
  }
  return response;
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

  // Validate home_path at the service layer (defense-in-depth beyond Zod)
  if (input.home_path !== undefined && input.home_path !== null) {
    validateHomePath(input.home_path);
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

  // Auth method switching
  if (input.auth_method === 'password') {
    // Switch to password auth: generate password, clear SSH keys
    const plainPassword = generateSecurePassword(24);
    const passwordHash = await bcrypt.hash(plainPassword, BCRYPT_COST);
    await db.update(sftpUsers).set({ passwordHash }).where(eq(sftpUsers.id, userId));
    // Clear linked SSH keys
    await db.delete(sftpUserSshKeys).where(eq(sftpUserSshKeys.sftpUserId, userId));

    const [updated] = await db.select().from(sftpUsers).where(eq(sftpUsers.id, userId));
    const linkedKeysMap = await fetchLinkedSshKeys(db, [updated.id]);
    return {
      ...mapSftpUserToResponse(updated),
      linkedSshKeys: linkedKeysMap.get(updated.id) ?? [],
      password: plainPassword,
    };
  } else if (input.auth_method === 'ssh_key') {
    // Switch to SSH key auth: clear password, require keys
    if (!input.ssh_key_ids || input.ssh_key_ids.length === 0) {
      throw new ApiError('SSH_KEYS_REQUIRED', 'At least one SSH key is required when switching to SSH key auth', 400);
    }
    await db.update(sftpUsers).set({ passwordHash: null }).where(eq(sftpUsers.id, userId));
    // Delete existing links and insert new ones
    await db.delete(sftpUserSshKeys).where(eq(sftpUserSshKeys.sftpUserId, userId));
    for (const sshKeyId of input.ssh_key_ids) {
      await db.insert(sftpUserSshKeys).values({
        id: crypto.randomUUID(),
        sftpUserId: userId,
        sshKeyId,
      });
    }

    const [updated] = await db.select().from(sftpUsers).where(eq(sftpUsers.id, userId));
    const linkedKeysMap = await fetchLinkedSshKeys(db, [updated.id]);
    return {
      ...mapSftpUserToResponse(updated),
      linkedSshKeys: linkedKeysMap.get(updated.id) ?? [],
    };
  }

  // Update linked SSH keys if provided (when auth_method is NOT being switched)
  if (input.ssh_key_ids !== undefined) {
    // Delete all existing links
    await db.delete(sftpUserSshKeys).where(eq(sftpUserSshKeys.sftpUserId, userId));
    // Insert new links
    for (const sshKeyId of input.ssh_key_ids) {
      await db.insert(sftpUserSshKeys).values({
        id: crypto.randomUUID(),
        sftpUserId: userId,
        sshKeyId,
      });
    }
  }

  const [updated] = await db.select().from(sftpUsers).where(eq(sftpUsers.id, userId));
  const linkedKeysMap = await fetchLinkedSshKeys(db, [updated.id]);

  return {
    ...mapSftpUserToResponse(updated),
    linkedSshKeys: linkedKeysMap.get(updated.id) ?? [],
  };
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

  if (!existing.passwordHash) {
    throw new ApiError('SSH_KEY_ONLY_USER', 'Cannot rotate password for SSH-key-only users. This user authenticates via SSH key.', 400);
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
  const ftpsPort = Number(settingsMap.get('sftp_gateway_ftps_port') ?? '2121');

  return {
    host,
    port,
    ftps_port: ftpsPort,
    protocols: ['sftp', 'scp', 'rsync', 'ftps'],
    username_format: '<sftp_username>',
    instructions: {
      sftp: `sftp -P ${port} <username>@${host}`,
      scp: `scp -P ${port} file.txt <username>@${host}:/path/`,
      rsync: `rsync -e "ssh -p ${port}" file.txt <username>@${host}:/path/`,
      ftps: `curl --ftp-ssl -T file.txt ftp://<username>:<password>@${host}:${ftpsPort}/`,
      sftp_key: `sftp -P ${port} -i ~/.ssh/id_ed25519 <username>@${host}`,
      scp_key: `scp -P ${port} -i ~/.ssh/id_ed25519 file.txt <username>@${host}:/path/`,
    },
    ssh_key_note: 'SSH keys uploaded on the SSH Keys page can be used for password-less authentication with SFTP, SCP, and rsync. FTPS only supports password authentication.',
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
