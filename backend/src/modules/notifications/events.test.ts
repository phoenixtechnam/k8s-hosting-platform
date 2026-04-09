import { describe, it, expect, vi, beforeEach } from 'vitest';

const createNotificationMock = vi.fn().mockResolvedValue({ id: 'n1', userId: 'u1', type: 'warning', title: 't', message: 'm' });
const sendNotificationEmailMock = vi.fn().mockResolvedValue(undefined);

vi.mock('./service.js', async () => {
  return {
    createNotification: createNotificationMock,
    notifyUser: async (
      _db: unknown,
      userId: string,
      opts: {
        type: 'info' | 'warning' | 'error' | 'success';
        title: string;
        message: string;
        resourceType?: string | null;
        resourceId?: string | null;
      },
    ) => {
      await createNotificationMock({ userId, ...opts });
    },
    notifyUsers: async (
      _db: unknown,
      userIds: readonly string[],
      opts: {
        type: 'info' | 'warning' | 'error' | 'success';
        title: string;
        message: string;
        resourceType?: string | null;
        resourceId?: string | null;
      },
    ) => {
      for (const uid of userIds) {
        await createNotificationMock({ userId: uid, ...opts });
      }
    },
  };
});

vi.mock('./email-sender.js', () => ({
  sendNotificationEmail: sendNotificationEmailMock,
}));

// Mock recipients helper so the fan-out path is deterministic.
const recipientsMock = vi.fn().mockResolvedValue(['u1', 'u2']);
vi.mock('./recipients.js', () => ({
  getClientNotificationRecipients: recipientsMock,
}));

const {
  notifyClientMailboxLimitReached,
  notifyClientDkimRotated,
  notifyClientImapsyncTerminal,
  notifyClientEmailBootstrapped,
} = await import('./events.js');

describe('notification events', () => {
  beforeEach(() => {
    createNotificationMock.mockClear();
    sendNotificationEmailMock.mockClear();
    recipientsMock.mockClear();
    recipientsMock.mockResolvedValue(['u1', 'u2']);
  });

  describe('notifyClientMailboxLimitReached', () => {
    it('fans out to all client_admin users with an error-level notification', async () => {
      await notifyClientMailboxLimitReached({} as never, 'c1', {
        limit: 10,
        current: 10,
        source: 'plan',
      });
      expect(recipientsMock).toHaveBeenCalledWith({}, 'c1');
      expect(createNotificationMock).toHaveBeenCalledTimes(2);
      const firstCall = createNotificationMock.mock.calls[0][0];
      expect(firstCall.userId).toBe('u1');
      expect(firstCall.type).toBe('error');
      expect(firstCall.title).toMatch(/Mailbox limit/i);
      expect(firstCall.message).toContain('10');
      expect(firstCall.resourceType).toBe('client');
      expect(firstCall.resourceId).toBe('c1');
    });

    it('silently skips when the client has no admins', async () => {
      recipientsMock.mockResolvedValue([]);
      await notifyClientMailboxLimitReached({} as never, 'c1', {
        limit: 10,
        current: 10,
        source: 'plan',
      });
      expect(createNotificationMock).not.toHaveBeenCalled();
    });
  });

  describe('notifyClientDkimRotated', () => {
    it('sends an info notification tagged with email_domain', async () => {
      await notifyClientDkimRotated({} as never, 'c1', {
        emailDomainId: 'ed1',
        domainName: 'example.com',
        selector: 'default',
      });
      expect(createNotificationMock).toHaveBeenCalledTimes(2);
      const call = createNotificationMock.mock.calls[0][0];
      expect(call.type).toBe('info');
      expect(call.title).toMatch(/DKIM/i);
      expect(call.message).toContain('example.com');
      expect(call.resourceType).toBe('email_domain');
      expect(call.resourceId).toBe('ed1');
    });
  });

  describe('notifyClientImapsyncTerminal', () => {
    it('fires a success notification on completed status', async () => {
      await notifyClientImapsyncTerminal({} as never, 'c1', {
        jobId: 'j1',
        status: 'completed',
        messagesTransferred: 42,
      });
      const call = createNotificationMock.mock.calls[0][0];
      expect(call.type).toBe('success');
      expect(call.title).toMatch(/IMAPSync/i);
      expect(call.message).toContain('42');
      expect(call.resourceType).toBe('imapsync_job');
      expect(call.resourceId).toBe('j1');
    });

    it('fires an error notification on failed status', async () => {
      await notifyClientImapsyncTerminal({} as never, 'c1', {
        jobId: 'j1',
        status: 'failed',
        errorMessage: 'auth failure',
      });
      const call = createNotificationMock.mock.calls[0][0];
      expect(call.type).toBe('error');
      expect(call.message).toContain('auth failure');
    });

    it('does not fire for non-terminal status', async () => {
      await notifyClientImapsyncTerminal({} as never, 'c1', {
        jobId: 'j1',
        status: 'running' as never,
      });
      expect(createNotificationMock).not.toHaveBeenCalled();
    });
  });

  describe('notifyClientEmailBootstrapped', () => {
    it('sends a success notification with the domain name', async () => {
      await notifyClientEmailBootstrapped({} as never, 'c1', {
        emailDomainId: 'ed1',
        domainName: 'example.com',
      });
      const call = createNotificationMock.mock.calls[0][0];
      expect(call.type).toBe('success');
      expect(call.title).toMatch(/enabled|email/i);
      expect(call.message).toContain('example.com');
      expect(call.resourceType).toBe('email_domain');
      expect(call.resourceId).toBe('ed1');
    });
  });
});
