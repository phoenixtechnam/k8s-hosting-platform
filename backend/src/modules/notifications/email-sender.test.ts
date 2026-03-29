import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendNotificationEmail } from './email-sender.js';

// Mock nodemailer
const mockSendMail = vi.fn();
const mockCreateTransport = vi.fn().mockReturnValue({ sendMail: mockSendMail });

vi.mock('nodemailer', () => ({
  default: { createTransport: (...args: unknown[]) => mockCreateTransport(...args) },
}));

// Mock crypto
vi.mock('../oidc/crypto.js', () => ({
  decrypt: vi.fn().mockReturnValue('decrypted-password'),
}));

type Db = Parameters<typeof sendNotificationEmail>[0];

function createMockDb(options: {
  user?: { email: string; fullName: string } | null;
  relay?: Record<string, unknown> | null;
} = {}) {
  const { user = { email: 'user@example.com', fullName: 'Test User' }, relay = null } = options;

  let selectCallIndex = 0;
  const results = [
    user ? [{ email: user.email, fullName: user.fullName }] : [],
    relay ? [relay] : [],
  ];

  const whereFn = vi.fn().mockImplementation(() => {
    const idx = selectCallIndex++;
    return Promise.resolve(results[Math.min(idx, results.length - 1)]);
  });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  return { select: selectFn } as unknown as Db;
}

const defaultRelay = {
  id: 'relay-1',
  name: 'Default Relay',
  providerType: 'mailgun',
  isDefault: 1,
  enabled: 1,
  smtpHost: 'smtp.mailgun.org',
  smtpPort: 587,
  authUsername: 'postmaster@example.com',
  authPasswordEncrypted: 'encrypted-value',
};

const defaultNotification = {
  id: 'n1',
  userId: 'u1',
  type: 'info',
  title: 'Test Notification',
  message: 'This is a test message',
};

const encryptionKey = '0'.repeat(64);

describe('sendNotificationEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMail.mockResolvedValue({ messageId: 'msg-1' });
  });

  it('should send email with correct subject and body', async () => {
    const db = createMockDb({ relay: defaultRelay });

    await sendNotificationEmail(db, defaultNotification, encryptionKey);

    expect(mockCreateTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: 'smtp.mailgun.org',
      port: 587,
    }));

    expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'user@example.com',
      subject: '[Hosting Platform] Test Notification',
    }));

    const htmlArg = mockSendMail.mock.calls[0][0].html;
    expect(htmlArg).toContain('Test Notification');
    expect(htmlArg).toContain('This is a test message');
  });

  it('should not send when no SMTP relay is configured', async () => {
    const db = createMockDb({ relay: null });

    await sendNotificationEmail(db, defaultNotification, encryptionKey);

    expect(mockCreateTransport).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('should not send when user has no email', async () => {
    const db = createMockDb({ user: null, relay: defaultRelay });

    await sendNotificationEmail(db, defaultNotification, encryptionKey);

    expect(mockCreateTransport).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('should not throw on sendMail error (fire-and-forget)', async () => {
    const db = createMockDb({ relay: defaultRelay });
    mockSendMail.mockRejectedValue(new Error('SMTP connection failed'));

    // Should not throw
    await expect(
      sendNotificationEmail(db, defaultNotification, encryptionKey),
    ).resolves.toBeUndefined();
  });
});
