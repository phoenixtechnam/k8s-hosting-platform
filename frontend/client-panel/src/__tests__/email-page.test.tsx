import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Email from '../pages/Email';

vi.mock('../hooks/use-auth', () => ({
  useAuth: vi.fn(() => ({
    user: { id: 'client-1', email: 'test@example.com', fullName: 'Test User', role: 'client' },
    token: 'test-token',
    isAuthenticated: true,
    isLoading: false,
    error: null,
    login: vi.fn(),
    logout: vi.fn(),
    initialize: vi.fn(),
  })),
}));

vi.mock('../hooks/use-client-context', () => ({
  useClientContext: vi.fn(() => ({
    clientId: 'client-1',
    clientName: 'Test Company',
    isLoading: false,
  })),
}));

vi.mock('../hooks/use-email', () => ({
  useEmailDomains: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
  useMailboxes: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
  useCreateMailbox: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, error: null })),
  useDeleteMailbox: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useUpdateMailbox: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, error: null })),
  useEmailAliases: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
  useCreateEmailAlias: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, error: null })),
  useDeleteEmailAlias: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useWebmailToken: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useEnableEmailDomain: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useUpdateEmailDomain: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, error: null })),
  useEmailDomainDnsRecords: vi.fn(() => ({ data: undefined, isLoading: false, error: null })),
  useDkimKeys: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
  useRotateDkimKey: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, error: null })),
  useActivateDkimKey: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useMailSubmitCredential: vi.fn(() => ({ data: { data: { exists: false } }, isLoading: false })),
  useRotateMailSubmitCredential: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, error: null })),
  useImapSyncJobs: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
  useCreateImapSyncJob: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useCancelImapSyncJob: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useMailRateLimit: vi.fn(() => ({
    data: { data: { limitPerHour: 100, source: 'hardcoded_default', suspended: false } },
    isLoading: false,
  })),
}));

import { useEmailDomains, useMailboxes, useUpdateMailbox, useEmailDomainDnsRecords } from '../hooks/use-email';

const mockedUseEmailDomains = vi.mocked(useEmailDomains);
const mockedUseMailboxes = vi.mocked(useMailboxes);
const mockedUseUpdateMailbox = vi.mocked(useUpdateMailbox);
const mockedUseEmailDomainDnsRecords = vi.mocked(useEmailDomainDnsRecords);

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Email Page', () => {
  it('renders the heading', () => {
    renderWithProviders(<Email />);
    expect(screen.getByTestId('email-heading')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
  });

  it('shows email not enabled when no domains', () => {
    renderWithProviders(<Email />);
    expect(screen.getByTestId('email-not-enabled')).toBeInTheDocument();
    expect(screen.getByText('Email Not Enabled')).toBeInTheDocument();
  });

  it('shows Mailboxes and Aliases tabs when domains exist', () => {
    mockedUseEmailDomains.mockReturnValue({
      data: { data: [{ id: 'd1', domainName: 'example.com' }] },
      isLoading: false,
    } as unknown as ReturnType<typeof useEmailDomains>);

    renderWithProviders(<Email />);
    expect(screen.getByTestId('tab-mailboxes')).toBeInTheDocument();
    expect(screen.getByTestId('tab-aliases')).toBeInTheDocument();
    expect(screen.getByText('Mailboxes')).toBeInTheDocument();
    expect(screen.getByText('Aliases & Forwarding')).toBeInTheDocument();
  });

  it('shows mailboxes tab content by default when domains exist', () => {
    mockedUseEmailDomains.mockReturnValue({
      data: { data: [{ id: 'd1', domainName: 'example.com' }] },
      isLoading: false,
    } as unknown as ReturnType<typeof useEmailDomains>);

    renderWithProviders(<Email />);
    expect(screen.getByTestId('add-mailbox-button')).toBeInTheDocument();
    expect(screen.getByTestId('mailboxes-table')).toBeInTheDocument();
  });

  it('shows empty mailbox message when no mailboxes', () => {
    mockedUseEmailDomains.mockReturnValue({
      data: { data: [{ id: 'd1', domainName: 'example.com' }] },
      isLoading: false,
    } as unknown as ReturnType<typeof useEmailDomains>);

    renderWithProviders(<Email />);
    expect(screen.getByText('No mailboxes yet. Create your first mailbox to get started.')).toBeInTheDocument();
  });

  it('shows an Edit button per mailbox row', async () => {
    mockedUseEmailDomains.mockReturnValue({
      data: { data: [{ id: 'd1', domainName: 'example.com' }] },
      isLoading: false,
    } as unknown as ReturnType<typeof useEmailDomains>);
    mockedUseMailboxes.mockReturnValue({
      data: {
        data: [
          {
            id: 'mb-1',
            emailDomainId: 'd1',
            clientId: 'client-1',
            fullAddress: 'alice@example.com',
            displayName: 'Alice',
            quotaMb: 1024,
            usedMb: 128,
            status: 'active',
            mailboxType: 'mailbox',
            autoReply: 0,
            autoReplySubject: null,
          },
        ],
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useMailboxes>);

    renderWithProviders(<Email />);
    expect(screen.getByTestId('edit-mailbox-mb-1')).toBeInTheDocument();
  });

  it('opens the edit modal when the Edit button is clicked', async () => {
    const { fireEvent } = await import('@testing-library/react');
    mockedUseEmailDomains.mockReturnValue({
      data: { data: [{ id: 'd1', domainName: 'example.com' }] },
      isLoading: false,
    } as unknown as ReturnType<typeof useEmailDomains>);
    mockedUseMailboxes.mockReturnValue({
      data: {
        data: [
          {
            id: 'mb-1',
            emailDomainId: 'd1',
            clientId: 'client-1',
            fullAddress: 'alice@example.com',
            displayName: 'Alice',
            quotaMb: 1024,
            usedMb: 128,
            status: 'active',
            mailboxType: 'mailbox',
            autoReply: 0,
            autoReplySubject: null,
          },
        ],
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useMailboxes>);

    renderWithProviders(<Email />);
    fireEvent.click(screen.getByTestId('edit-mailbox-mb-1'));

    // Modal should surface fields for the edit-allowed props
    expect(screen.getByTestId('edit-mailbox-modal')).toBeInTheDocument();
    expect(screen.getByTestId('edit-mailbox-display-name')).toHaveValue('Alice');
    expect(screen.getByTestId('edit-mailbox-quota')).toHaveValue(1024);
    // Password field is optional — empty by default so we don't
    // accidentally reset the password to an empty string
    expect(screen.getByTestId('edit-mailbox-password')).toHaveValue('');
    expect(screen.getByTestId('edit-mailbox-status')).toBeInTheDocument();
  });

  it('shows the Settings & DNS tab when domains exist', async () => {
    const { fireEvent } = await import('@testing-library/react');
    mockedUseEmailDomains.mockReturnValue({
      data: {
        data: [
          {
            id: 'd1',
            domainId: 'd1',
            domainName: 'example.com',
            enabled: 1,
            webmailEnabled: 1,
            maxMailboxes: 50,
            maxQuotaMb: 10240,
            catchAllAddress: null,
            spamThresholdJunk: '5.0',
            spamThresholdReject: '10.0',
            dnsMode: 'cname',
          },
        ],
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useEmailDomains>);

    mockedUseEmailDomainDnsRecords.mockReturnValue({
      data: {
        data: {
          dnsMode: 'cname',
          manualRequired: true,
          mailServerHostname: 'mail.platform.test',
          records: [
            { type: 'MX', name: 'example.com', value: 'mail.example.com', ttl: 3600, priority: 10 },
            { type: 'TXT', name: 'example.com', value: 'v=spf1 mx ~all', ttl: 3600, priority: null },
          ],
        },
      },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useEmailDomainDnsRecords>);

    renderWithProviders(<Email />);
    fireEvent.click(screen.getByTestId('tab-settings'));

    expect(screen.getByTestId('settings-tab')).toBeInTheDocument();
    expect(screen.getByTestId('domain-settings-form')).toBeInTheDocument();
    expect(screen.getByTestId('dns-records-card')).toBeInTheDocument();
    // cname mode → should show the manual-publish banner
    expect(screen.getByText(/Manual DNS publishing required/i)).toBeInTheDocument();
    // Records table should render the rows
    expect(screen.getByTestId('dns-records-table')).toBeInTheDocument();
  });

  it('submits only the changed fields to useUpdateMailbox', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const mutateAsync = vi.fn().mockResolvedValue({ data: { id: 'mb-1' } });
    mockedUseUpdateMailbox.mockReturnValue({
      mutateAsync,
      isPending: false,
      error: null,
    } as unknown as ReturnType<typeof useUpdateMailbox>);
    mockedUseEmailDomains.mockReturnValue({
      data: { data: [{ id: 'd1', domainName: 'example.com' }] },
      isLoading: false,
    } as unknown as ReturnType<typeof useEmailDomains>);
    mockedUseMailboxes.mockReturnValue({
      data: {
        data: [
          {
            id: 'mb-1',
            emailDomainId: 'd1',
            clientId: 'client-1',
            fullAddress: 'alice@example.com',
            displayName: 'Alice',
            quotaMb: 1024,
            usedMb: 128,
            status: 'active',
            mailboxType: 'mailbox',
            autoReply: 0,
            autoReplySubject: null,
          },
        ],
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useMailboxes>);

    renderWithProviders(<Email />);
    fireEvent.click(screen.getByTestId('edit-mailbox-mb-1'));

    // Change the display name and quota, leave password blank
    fireEvent.change(screen.getByTestId('edit-mailbox-display-name'), {
      target: { value: 'Alice Wonder' },
    });
    fireEvent.change(screen.getByTestId('edit-mailbox-quota'), {
      target: { value: '2048' },
    });

    fireEvent.click(screen.getByTestId('submit-edit-mailbox'));

    // Wait a microtask for the async submission
    await new Promise(r => setTimeout(r, 0));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    const call = mutateAsync.mock.calls[0][0] as { id: string; input: Record<string, unknown> };
    expect(call.id).toBe('mb-1');
    expect(call.input.display_name).toBe('Alice Wonder');
    expect(call.input.quota_mb).toBe(2048);
    // Empty password → should NOT be sent
    expect(call.input.password).toBeUndefined();
    // Status unchanged → should NOT be sent
    expect(call.input.status).toBeUndefined();
  });
});
