import { eq } from 'drizzle-orm';
import { smtpRelayConfigs } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { encrypt, decrypt } from '../oidc/crypto.js';
import type { Database } from '../../db/index.js';
import type { CreateSmtpRelayInput, UpdateSmtpRelayInput } from '@k8s-hosting/api-contracts';
import type { SmtpRelayAdapter } from './adapters/types.js';
import { DirectAdapter } from './adapters/direct.js';
import { MailgunAdapter } from './adapters/mailgun.js';
import { PostmarkAdapter } from './adapters/postmark.js';

function sanitizeConfig(row: typeof smtpRelayConfigs.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    providerType: row.providerType,
    isDefault: row.isDefault,
    enabled: row.enabled,
    smtpHost: row.smtpHost,
    smtpPort: row.smtpPort,
    authUsername: row.authUsername,
    region: row.region,
    lastTestedAt: row.lastTestedAt,
    lastTestStatus: row.lastTestStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createRelayConfig(
  db: Database,
  input: CreateSmtpRelayInput,
  encryptionKey: string,
) {
  const id = crypto.randomUUID();
  const values: Record<string, unknown> = {
    id,
    name: input.name,
    providerType: input.provider_type,
    enabled: input.enabled !== false ? 1 : 0,
  };

  if (input.provider_type === 'mailgun') {
    values.smtpHost = input.smtp_host ?? 'smtp.mailgun.org';
    values.smtpPort = input.smtp_port ?? 587;
    values.authUsername = input.auth_username;
    values.authPasswordEncrypted = encrypt(input.auth_password, encryptionKey);
    values.region = input.region ?? 'eu';
  } else if (input.provider_type === 'postmark') {
    values.smtpHost = input.smtp_host ?? 'smtp.postmarkapp.com';
    values.smtpPort = input.smtp_port ?? 587;
    values.apiKeyEncrypted = encrypt(input.api_key, encryptionKey);
  }

  await db.insert(smtpRelayConfigs).values(values as typeof smtpRelayConfigs.$inferInsert);

  const [created] = await db.select().from(smtpRelayConfigs).where(eq(smtpRelayConfigs.id, id));
  return sanitizeConfig(created);
}

export async function listRelayConfigs(db: Database) {
  const rows = await db.select().from(smtpRelayConfigs);
  return rows.map(sanitizeConfig);
}

export async function updateRelayConfig(
  db: Database,
  id: string,
  input: UpdateSmtpRelayInput,
  encryptionKey: string,
) {
  const [existing] = await db.select().from(smtpRelayConfigs).where(eq(smtpRelayConfigs.id, id));
  if (!existing) {
    throw new ApiError('SMTP_RELAY_NOT_FOUND', `SMTP relay config '${id}' not found`, 404);
  }

  const updateValues: Record<string, unknown> = {};
  if (input.name !== undefined) updateValues.name = input.name;
  if (input.smtp_host !== undefined) updateValues.smtpHost = input.smtp_host;
  if (input.smtp_port !== undefined) updateValues.smtpPort = input.smtp_port;
  if (input.auth_username !== undefined) updateValues.authUsername = input.auth_username;
  if (input.auth_password !== undefined) {
    updateValues.authPasswordEncrypted = encrypt(input.auth_password, encryptionKey);
  }
  if (input.api_key !== undefined) {
    updateValues.apiKeyEncrypted = encrypt(input.api_key, encryptionKey);
  }
  if (input.region !== undefined) updateValues.region = input.region;
  if (input.enabled !== undefined) updateValues.enabled = input.enabled ? 1 : 0;
  if (input.is_default !== undefined) updateValues.isDefault = input.is_default ? 1 : 0;

  if (Object.keys(updateValues).length > 0) {
    await db.update(smtpRelayConfigs).set(updateValues).where(eq(smtpRelayConfigs.id, id));
  }

  const [updated] = await db.select().from(smtpRelayConfigs).where(eq(smtpRelayConfigs.id, id));
  return sanitizeConfig(updated);
}

export async function deleteRelayConfig(db: Database, id: string) {
  const [existing] = await db.select().from(smtpRelayConfigs).where(eq(smtpRelayConfigs.id, id));
  if (!existing) {
    throw new ApiError('SMTP_RELAY_NOT_FOUND', `SMTP relay config '${id}' not found`, 404);
  }

  await db.delete(smtpRelayConfigs).where(eq(smtpRelayConfigs.id, id));
}

export function getAdapterForConfig(
  config: typeof smtpRelayConfigs.$inferSelect,
  encryptionKey: string,
): SmtpRelayAdapter {
  switch (config.providerType) {
    case 'direct':
      return new DirectAdapter();

    case 'mailgun':
      return new MailgunAdapter({
        smtpHost: config.smtpHost ?? 'smtp.mailgun.org',
        smtpPort: config.smtpPort ?? 587,
        authUsername: config.authUsername ?? '',
        authPassword: config.authPasswordEncrypted
          ? decrypt(config.authPasswordEncrypted, encryptionKey)
          : '',
      });

    case 'postmark': {
      const apiKey = config.apiKeyEncrypted
        ? decrypt(config.apiKeyEncrypted, encryptionKey)
        : '';
      return new PostmarkAdapter({
        smtpHost: config.smtpHost ?? 'smtp.postmarkapp.com',
        smtpPort: config.smtpPort ?? 587,
        apiKey,
      });
    }

    default:
      throw new ApiError('INVALID_PROVIDER_TYPE', `Unknown provider type: ${config.providerType}`, 400);
  }
}

export async function testRelayConnection(db: Database, id: string, encryptionKey: string) {
  const [config] = await db.select().from(smtpRelayConfigs).where(eq(smtpRelayConfigs.id, id));
  if (!config) {
    throw new ApiError('SMTP_RELAY_NOT_FOUND', `SMTP relay config '${id}' not found`, 404);
  }

  const adapter = getAdapterForConfig(config, encryptionKey);
  const result = await adapter.testConnection();

  const now = new Date();
  await db
    .update(smtpRelayConfigs)
    .set({ lastTestedAt: now, lastTestStatus: result.status })
    .where(eq(smtpRelayConfigs.id, id));

  return result;
}

export async function getDefaultRelay(
  db: Database,
  encryptionKey: string,
): Promise<SmtpRelayAdapter | null> {
  const [config] = await db
    .select()
    .from(smtpRelayConfigs)
    .where(eq(smtpRelayConfigs.isDefault, 1));

  if (!config) return null;
  if (config.providerType === 'direct') return null;

  return getAdapterForConfig(config, encryptionKey);
}
