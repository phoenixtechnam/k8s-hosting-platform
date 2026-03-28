import { describe, it, expect, vi } from 'vitest';
import {
  createRelayConfig,
  listRelayConfigs,
  testRelayConnection,
  getAdapterForConfig,
  getDefaultRelay,
} from './service.js';
import { encrypt } from '../oidc/crypto.js';

// 32-byte hex key for AES-256
const TEST_KEY = 'a'.repeat(64);

const MAILGUN_ROW = {
  id: 'r1',
  name: 'Mailgun EU',
  providerType: 'mailgun' as const,
  isDefault: 0,
  enabled: 1,
  smtpHost: 'smtp.eu.mailgun.org',
  smtpPort: 587,
  authUsername: 'api',
  authPasswordEncrypted: encrypt('secret123', TEST_KEY),
  apiKeyEncrypted: null,
  region: 'eu',
  lastTestedAt: null,
  lastTestStatus: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const POSTMARK_ROW = {
  ...MAILGUN_ROW,
  id: 'r2',
  name: 'Postmark',
  providerType: 'postmark' as const,
  smtpHost: 'smtp.postmarkapp.com',
  authUsername: null,
  authPasswordEncrypted: null,
  apiKeyEncrypted: encrypt('pm-key-123', TEST_KEY),
  region: null,
};

const DIRECT_ROW = {
  ...MAILGUN_ROW,
  id: 'r3',
  name: 'Direct',
  providerType: 'direct' as const,
  smtpHost: null,
  smtpPort: null,
  authUsername: null,
  authPasswordEncrypted: null,
  apiKeyEncrypted: null,
  region: null,
};

function createMockDb(selectResults: unknown[][] = []) {
  let callIdx = 0;
  const whereFn = vi.fn().mockImplementation(() => {
    const result = selectResults[callIdx] ?? [];
    callIdx++;
    return Promise.resolve(result);
  });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  const insertValues = vi.fn().mockResolvedValue(undefined);
  const insertFn = vi.fn().mockReturnValue({ values: insertValues });

  const updateSetWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateSetWhere });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });

  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

  return {
    select: selectFn,
    insert: insertFn,
    update: updateFn,
    delete: deleteFn,
  } as unknown as Parameters<typeof createRelayConfig>[0];
}

describe('createRelayConfig', () => {
  it('should create Mailgun relay config and encrypt credentials', async () => {
    const sanitized = {
      id: MAILGUN_ROW.id,
      name: MAILGUN_ROW.name,
      providerType: MAILGUN_ROW.providerType,
      isDefault: MAILGUN_ROW.isDefault,
      enabled: MAILGUN_ROW.enabled,
      smtpHost: MAILGUN_ROW.smtpHost,
      smtpPort: MAILGUN_ROW.smtpPort,
      authUsername: MAILGUN_ROW.authUsername,
      region: MAILGUN_ROW.region,
      lastTestedAt: MAILGUN_ROW.lastTestedAt,
      lastTestStatus: MAILGUN_ROW.lastTestStatus,
      createdAt: MAILGUN_ROW.createdAt,
      updatedAt: MAILGUN_ROW.updatedAt,
    };
    const db = createMockDb([[MAILGUN_ROW]]);

    const result = await createRelayConfig(db, {
      provider_type: 'mailgun',
      name: 'Mailgun EU',
      smtp_host: 'smtp.eu.mailgun.org',
      smtp_port: 587,
      auth_username: 'api',
      auth_password: 'secret123',
      region: 'eu',
      enabled: true,
    }, TEST_KEY);

    expect(result).toEqual(sanitized);
    // Verify insert was called (credentials encrypted internally)
    expect((db as any).insert).toHaveBeenCalled();
  });

  it('should create Postmark relay config and encrypt API key', async () => {
    const db = createMockDb([[POSTMARK_ROW]]);

    const result = await createRelayConfig(db, {
      provider_type: 'postmark',
      name: 'Postmark',
      smtp_host: 'smtp.postmarkapp.com',
      smtp_port: 587,
      api_key: 'pm-key-123',
      enabled: true,
    }, TEST_KEY);

    expect(result.providerType).toBe('postmark');
    expect(result).not.toHaveProperty('authPasswordEncrypted');
    expect(result).not.toHaveProperty('apiKeyEncrypted');
  });

  it('should create direct relay with no credentials', async () => {
    const db = createMockDb([[DIRECT_ROW]]);

    const result = await createRelayConfig(db, {
      provider_type: 'direct',
      name: 'Direct',
      enabled: true,
    }, TEST_KEY);

    expect(result.providerType).toBe('direct');
    expect(result.smtpHost).toBeNull();
  });
});

describe('listRelayConfigs', () => {
  it('should list configs and mask sensitive fields', async () => {
    const fromFn = vi.fn().mockResolvedValue([MAILGUN_ROW, POSTMARK_ROW]);
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = { select: selectFn } as unknown as Parameters<typeof listRelayConfigs>[0];

    const result = await listRelayConfigs(db);

    expect(result).toHaveLength(2);
    // Verify sensitive fields are stripped
    for (const config of result) {
      expect(config).not.toHaveProperty('authPasswordEncrypted');
      expect(config).not.toHaveProperty('apiKeyEncrypted');
    }
  });
});

describe('testRelayConnection', () => {
  it('should return ok for valid Mailgun config', async () => {
    const db = createMockDb([[MAILGUN_ROW]]);

    const result = await testRelayConnection(db, 'r1', TEST_KEY);

    expect(result.status).toBe('ok');
    // Verify lastTestedAt was updated
    expect((db as any).update).toHaveBeenCalled();
  });
});

describe('getAdapterForConfig', () => {
  it('should return DirectAdapter for direct type', () => {
    const adapter = getAdapterForConfig(DIRECT_ROW, TEST_KEY);
    expect(adapter.providerType).toBe('direct');
  });

  it('should return MailgunAdapter for mailgun type', () => {
    const adapter = getAdapterForConfig(MAILGUN_ROW, TEST_KEY);
    expect(adapter.providerType).toBe('mailgun');
  });

  it('should return PostmarkAdapter for postmark type', () => {
    const adapter = getAdapterForConfig(POSTMARK_ROW, TEST_KEY);
    expect(adapter.providerType).toBe('postmark');
  });
});

describe('getDefaultRelay', () => {
  it('should return null when no default configured', async () => {
    const whereFn = vi.fn().mockResolvedValue([]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = { select: selectFn } as unknown as Parameters<typeof getDefaultRelay>[0];

    const result = await getDefaultRelay(db, TEST_KEY);
    expect(result).toBeNull();
  });

  it('should return null when default is direct', async () => {
    const directDefault = { ...DIRECT_ROW, isDefault: 1 };
    const whereFn = vi.fn().mockResolvedValue([directDefault]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = { select: selectFn } as unknown as Parameters<typeof getDefaultRelay>[0];

    const result = await getDefaultRelay(db, TEST_KEY);
    expect(result).toBeNull();
  });

  it('should return adapter when default is mailgun', async () => {
    const mailgunDefault = { ...MAILGUN_ROW, isDefault: 1 };
    const whereFn = vi.fn().mockResolvedValue([mailgunDefault]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = { select: selectFn } as unknown as Parameters<typeof getDefaultRelay>[0];

    const result = await getDefaultRelay(db, TEST_KEY);
    expect(result).not.toBeNull();
    expect(result!.providerType).toBe('mailgun');
  });
});
