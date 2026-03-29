import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Dashboard from '../pages/Dashboard';

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
  useClientContext: vi.fn(() => ({ clientId: 'c1', clientName: 'Test', isLoading: false })),
}));

vi.mock('../hooks/use-domains', () => ({
  useDomains: vi.fn(() => ({ data: { data: [] } })),
}));

vi.mock('../hooks/use-backups', () => ({
  useBackups: vi.fn(() => ({ data: { data: [] } })),
}));

vi.mock('../hooks/use-workloads', () => ({
  useWorkloads: vi.fn(() => ({ data: { data: [] } })),
  useContainerImages: vi.fn(() => ({ data: { data: [] } })),
  useCreateWorkload: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, error: null })),
  useDeleteWorkload: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, error: null })),
}));

import { useAuth } from '../hooks/use-auth';

const mockedUseAuth = vi.mocked(useAuth);

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

describe('Dashboard Page', () => {
  it('renders welcome heading with user name', () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByTestId('welcome-heading')).toBeInTheDocument();
    expect(screen.getByText(/Welcome back, Test User/)).toBeInTheDocument();
  });

  it('renders overview description', () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByText('Here is an overview of your hosting account.')).toBeInTheDocument();
  });

  it('renders quick stats grid with all four cards', () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByTestId('quick-stats')).toBeInTheDocument();
    expect(screen.getByText('Domains')).toBeInTheDocument();
    expect(screen.getByText('Applications')).toBeInTheDocument();
    expect(screen.getByText('Backups')).toBeInTheDocument();
    expect(screen.getByText('Workloads')).toBeInTheDocument();
  });

  it('shows zero values in stats cards when no data', () => {
    renderWithProviders(<Dashboard />);
    const zeros = screen.getAllByText('0');
    expect(zeros.length).toBe(4);
  });

  it('renders getting started section', () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByText('Getting Started')).toBeInTheDocument();
    expect(
      screen.getByText(/Use the sidebar navigation to manage your domains/),
    ).toBeInTheDocument();
  });

  it('shows email as fallback when fullName is null', () => {
    mockedUseAuth.mockReturnValue({
      user: { id: 'client-1', email: 'jane@example.com', fullName: null, role: 'client' },
      token: 'test-token',
      isAuthenticated: true,
      isLoading: false,
      error: null,
      login: vi.fn(),
      logout: vi.fn(),
      initialize: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);
    renderWithProviders(<Dashboard />);
    expect(screen.getByText(/Welcome back, jane@example.com/)).toBeInTheDocument();
  });

  it('shows "there" when both fullName and email are missing', () => {
    mockedUseAuth.mockReturnValue({
      user: null,
      token: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
      login: vi.fn(),
      logout: vi.fn(),
      initialize: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);
    renderWithProviders(<Dashboard />);
    expect(screen.getByText(/Welcome back, there/)).toBeInTheDocument();
  });
});
