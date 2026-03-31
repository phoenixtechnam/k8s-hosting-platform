import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Domains from '../pages/Domains';

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

vi.mock('../hooks/use-domains', () => ({
  useDomains: vi.fn(() => ({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
  })),
}));

import { useDomains } from '../hooks/use-domains';

const mockedUseDomains = vi.mocked(useDomains);

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

describe('Domains Page', () => {
  it('renders the heading and description', () => {
    mockedUseDomains.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useDomains>);
    renderWithProviders(<Domains />);
    expect(screen.getByTestId('domains-heading')).toBeInTheDocument();
    expect(screen.getByText('Domains')).toBeInTheDocument();
    expect(screen.getByText('Manage your domain names and DNS settings.')).toBeInTheDocument();
  });

  it('shows loading state with spinner', () => {
    mockedUseDomains.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useDomains>);
    renderWithProviders(<Domains />);
    expect(screen.getByTestId('domains-loading')).toBeInTheDocument();
    expect(screen.getByText('Loading domains...')).toBeInTheDocument();
  });

  it('shows empty state when no domains exist', () => {
    mockedUseDomains.mockReturnValue({
      data: { data: [], pagination: { total_count: 0, cursor: null, has_more: false, page_size: 20 } },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useDomains>);
    renderWithProviders(<Domains />);
    expect(screen.getByTestId('domains-empty')).toBeInTheDocument();
    expect(screen.getByText('No domains yet')).toBeInTheDocument();
    expect(screen.getByText('Add a domain to start routing traffic to your workloads.')).toBeInTheDocument();
  });

  it('shows error state with error message', () => {
    mockedUseDomains.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('Network error'),
    } as unknown as ReturnType<typeof useDomains>);
    renderWithProviders(<Domains />);
    expect(screen.getByTestId('domains-error')).toBeInTheDocument();
    expect(screen.getByText(/Network error/)).toBeInTheDocument();
  });

  it('renders domain list with name, status, and DNS mode', () => {
    mockedUseDomains.mockReturnValue({
      data: {
        data: [
          { id: '1', clientId: 'c1', domainName: 'example.com', status: 'active', dnsMode: 'managed', sslAutoRenew: 1, createdAt: '2025-01-01T00:00:00Z' },
          { id: '2', clientId: 'c1', domainName: 'test.org', status: 'pending', dnsMode: 'external', sslAutoRenew: 0, createdAt: '2025-02-01T00:00:00Z' },
        ],
        pagination: { total_count: 2, cursor: null, has_more: false, page_size: 20 },
      },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useDomains>);
    renderWithProviders(<Domains />);
    expect(screen.getByTestId('domains-table')).toBeInTheDocument();
    // Domain names
    expect(screen.getByText('example.com')).toBeInTheDocument();
    expect(screen.getByText('test.org')).toBeInTheDocument();
    // Status badges
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
    // DNS modes
    expect(screen.getByText('managed')).toBeInTheDocument();
    expect(screen.getByText('external')).toBeInTheDocument();
  });

  it('shows SSL auto-renew column values', () => {
    mockedUseDomains.mockReturnValue({
      data: {
        data: [
          { id: '1', clientId: 'c1', domainName: 'ssl-yes.com', status: 'active', dnsMode: 'managed', sslAutoRenew: 1, createdAt: '2025-01-01T00:00:00Z' },
          { id: '2', clientId: 'c1', domainName: 'ssl-no.com', status: 'active', dnsMode: 'managed', sslAutoRenew: 0, createdAt: '2025-02-01T00:00:00Z' },
        ],
        pagination: { total_count: 2, cursor: null, has_more: false, page_size: 20 },
      },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useDomains>);
    renderWithProviders(<Domains />);
    expect(screen.getByText('Auto (TLS)')).toBeInTheDocument();
    expect(screen.getByText('Manual')).toBeInTheDocument();
  });

  it('shows table header columns', () => {
    mockedUseDomains.mockReturnValue({
      data: {
        data: [
          { id: '1', clientId: 'c1', domainName: 'example.com', status: 'active', dnsMode: 'managed', sslAutoRenew: 1, createdAt: '2025-01-01T00:00:00Z' },
        ],
        pagination: { total_count: 1, cursor: null, has_more: false, page_size: 20 },
      },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useDomains>);
    renderWithProviders(<Domains />);
    expect(screen.getByText('Domain Name')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('DNS Mode')).toBeInTheDocument();
    expect(screen.getByText('SSL')).toBeInTheDocument();
    expect(screen.getByText('Created')).toBeInTheDocument();
  });

  it('does not show table when loading', () => {
    mockedUseDomains.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useDomains>);
    renderWithProviders(<Domains />);
    expect(screen.queryByTestId('domains-table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('domains-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('domains-error')).not.toBeInTheDocument();
  });

  it('does not show loading or empty when error occurs', () => {
    mockedUseDomains.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('Server down'),
    } as unknown as ReturnType<typeof useDomains>);
    renderWithProviders(<Domains />);
    expect(screen.queryByTestId('domains-loading')).not.toBeInTheDocument();
    expect(screen.queryByTestId('domains-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('domains-table')).not.toBeInTheDocument();
  });
});
