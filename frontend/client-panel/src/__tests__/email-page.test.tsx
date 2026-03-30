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
  useEmailAliases: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
  useCreateEmailAlias: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, error: null })),
  useDeleteEmailAlias: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useWebmailToken: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useEnableEmailDomain: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}));

import { useEmailDomains } from '../hooks/use-email';

const mockedUseEmailDomains = vi.mocked(useEmailDomains);

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
});
