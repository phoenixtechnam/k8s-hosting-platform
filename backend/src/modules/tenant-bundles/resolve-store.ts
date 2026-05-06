/**
 * Standalone bundle-store resolver for callers that don't have a
 * FastifyInstance (e.g. lifecycle hooks). Mirrors the inline
 * `resolveStore` in routes.ts but takes raw db + encryptionKey
 * instead of `app`. Both code paths must stay in sync.
 *
 * Returns null when the configured target is unsupported (e.g.
 * `kind=hostpath`) — callers should treat null as "no remote store
 * to clean up" and skip the bundle.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { backupConfigurations } from '../../db/schema.js';
import { decrypt } from '../oidc/crypto.js';
import type { BackupStore } from './bundle-store.js';
import { S3BackupStore } from './s3-backup-store.js';
import { SshBackupStore } from './ssh-backup-store.js';

export interface ResolveStoreOptions {
  /** When false, deactivated targets are still resolved (cleanup paths). */
  readonly requireActive?: boolean;
  /** Optional logger; falls back to console.warn on credential decrypt failures. */
  readonly logFn?: (level: 'info' | 'warn' | 'error', ctx: Record<string, unknown>, msg: string) => void;
}

export class ResolveStoreError extends Error {
  readonly code: 'NOT_FOUND' | 'CONFIG_INVALID' | 'NOT_IMPLEMENTED' | 'INACTIVE';
  constructor(code: ResolveStoreError['code'], message: string) {
    super(message);
    this.name = 'ResolveStoreError';
    this.code = code;
  }
}

export async function resolveBackupStore(
  db: Database,
  targetConfigId: string,
  encryptionKey: string,
  opts: ResolveStoreOptions = {},
): Promise<BackupStore | null> {
  const requireActive = opts.requireActive ?? true;
  const log = opts.logFn ?? ((_l, _c, m) => console.warn(m));

  const [cfg] = await db.select().from(backupConfigurations)
    .where(eq(backupConfigurations.id, targetConfigId)).limit(1);
  if (!cfg) {
    throw new ResolveStoreError('NOT_FOUND', `Backup target ${targetConfigId} not found`);
  }
  if (requireActive && !cfg.active) {
    throw new ResolveStoreError('INACTIVE',
      `Backup target ${cfg.id} is not active`);
  }

  if (cfg.storageType === 's3') {
    let accessKey = '';
    let secretKey = '';
    try {
      accessKey = cfg.s3AccessKeyEncrypted ? decrypt(cfg.s3AccessKeyEncrypted, encryptionKey) : '';
      secretKey = cfg.s3SecretKeyEncrypted ? decrypt(cfg.s3SecretKeyEncrypted, encryptionKey) : '';
    } catch (err) {
      log('error', { err, configId: cfg.id }, 'tenant-bundles: S3 credential decryption failed');
      throw new ResolveStoreError('CONFIG_INVALID',
        'S3 credential decryption failed (encryption key may have rotated)');
    }
    if (!accessKey || !secretKey) {
      throw new ResolveStoreError('CONFIG_INVALID',
        `Backup target ${cfg.id} has no S3 credentials configured`);
    }
    return new S3BackupStore({
      bucket: cfg.s3Bucket ?? '',
      region: cfg.s3Region ?? 'us-east-1',
      endpoint: cfg.s3Endpoint ?? undefined,
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      pathPrefix: cfg.s3Prefix ?? undefined,
    });
  }

  if (cfg.storageType === 'ssh') {
    if (!cfg.sshHost || !cfg.sshUser || !cfg.sshKeyEncrypted || !cfg.sshPath) {
      throw new ResolveStoreError('CONFIG_INVALID',
        `Backup target ${cfg.id} is missing SSH host/user/key/path`);
    }
    let privateKey = '';
    try {
      privateKey = decrypt(cfg.sshKeyEncrypted, encryptionKey);
    } catch (err) {
      log('error', { err, configId: cfg.id }, 'tenant-bundles: SSH key decryption failed');
      throw new ResolveStoreError('CONFIG_INVALID',
        'SSH key decryption failed (encryption key may have rotated)');
    }
    if (!privateKey) {
      throw new ResolveStoreError('CONFIG_INVALID',
        `Backup target ${cfg.id} has empty SSH key`);
    }
    return new SshBackupStore({
      host: cfg.sshHost,
      port: cfg.sshPort ?? 22,
      user: cfg.sshUser,
      privateKey,
      basePath: cfg.sshPath,
      logFn: log,
    });
  }

  // hostpath / unknown — caller can ignore.
  return null;
}
