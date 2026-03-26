import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Databases from '../pages/Databases';

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

const mockRotateCredentials = {
  mutateAsync: vi.fn(),
  isPending: false,
  error: null,
  reset: vi.fn(),
};

vi.mock('../hooks/use-databases', () => ({
  useDatabases: vi.fn(() => ({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
  })),
  useCreateDatabase: vi.fn(() => ({
    mutateAsync: vi.fn(),
    isPending: false,
    error: null,
    reset: vi.fn(),
  })),
  useRotateCredentials: vi.fn(() => mockRotateCredentials),
}));

import { useDatabases } from '../hooks/use-databases';

const mockedUseDatabases = vi.mocked(useDatabases);

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

describe('Databases Page', () => {
  it('renders the heading and description', () => {
    mockedUseDatabases.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useDatabases>);
    renderWithProviders(<Databases />);
    expect(screen.getByTestId('databases-heading')).toBeInTheDocument();
    expect(screen.getByText('Databases')).toBeInTheDocument();
    expect(screen.getByText('Manage your database instances.')).toBeInTheDocument();
  });

  it('shows loading state with spinner', () => {
    mockedUseDatabases.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useDatabases>);
    renderWithProviders(<Databases />);
    expect(screen.getByTestId('databases-loading')).toBeInTheDocument();
    expect(screen.getByText('Loading databases...')).toBeInTheDocument();
  });

  it('shows empty state when no databases exist', () => {
    mockedUseDatabases.mockReturnValue({
      data: { data: [], pagination: { total_count: 0, cursor: null, has_more: false, page_size: 20 } },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useDatabases>);
    renderWithProviders(<Databases />);
    expect(screen.getByTestId('databases-empty')).toBeInTheDocument();
    expect(screen.getByText('No databases yet')).toBeInTheDocument();
    expect(screen.getByText('Create your first database to get started.')).toBeInTheDocument();
  });

  it('shows error state with error message', () => {
    mockedUseDatabases.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('Server error'),
    } as unknown as ReturnType<typeof useDatabases>);
    renderWithProviders(<Databases />);
    expect(screen.getByTestId('databases-error')).toBeInTheDocument();
    expect(screen.getByText(/Server error/)).toBeInTheDocument();
  });

  it('renders database list with name, type, and status', () => {
    mockedUseDatabases.mockReturnValue({
      data: {
        data: [
          { id: 'db-1', clientId: 'c1', name: 'wp_main', databaseType: 'MariaDB', username: 'db_wp_main_abc', status: 'active', createdAt: '2025-01-15T00:00:00Z' },
          { id: 'db-2', clientId: 'c1', name: 'cache_store', databaseType: 'Redis', username: 'db_cache_xyz', status: 'provisioning', createdAt: '2025-03-01T00:00:00Z' },
        ],
        pagination: { total_count: 2, cursor: null, has_more: false, page_size: 20 },
      },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useDatabases>);
    renderWithProviders(<Databases />);
    expect(screen.getByTestId('databases-table')).toBeInTheDocument();
    // Database names
    expect(screen.getByText('wp_main')).toBeInTheDocument();
    expect(screen.getByText('cache_store')).toBeInTheDocument();
    // Database types
    expect(screen.getByText('MariaDB')).toBeInTheDocument();
    expect(screen.getByText('Redis')).toBeInTheDocument();
    // Statuses
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('provisioning')).toBeInTheDocument();
  });

  it('shows username column in table', () => {
    mockedUseDatabases.mockReturnValue({
      data: {
        data: [
          { id: 'db-1', clientId: 'c1', name: 'wp_main', databaseType: 'mysql', username: 'db_wp_main_abc12345', status: 'active', createdAt: '2025-01-15T00:00:00Z' },
        ],
        pagination: { total_count: 1, cursor: null, has_more: false, page_size: 20 },
      },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useDatabases>);
    renderWithProviders(<Databases />);
    expect(screen.getByText('Username')).toBeInTheDocument();
    expect(screen.getByText('db_wp_main_abc12345')).toBeInTheDocument();
  });

  it('shows Create Database button', () => {
    mockedUseDatabases.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useDatabases>);
    renderWithProviders(<Databases />);
    expect(screen.getByTestId('create-database-button')).toBeInTheDocument();
    expect(screen.getByText('Create Database')).toBeInTheDocument();
  });

  it('shows Rotate Password button for each database row', () => {
    mockedUseDatabases.mockReturnValue({
      data: {
        data: [
          { id: 'db-1', clientId: 'c1', name: 'app_db', databaseType: 'mysql', username: 'db_app_x', status: 'active', createdAt: '2025-01-15T00:00:00Z' },
          { id: 'db-2', clientId: 'c1', name: 'cache_db', databaseType: 'redis', username: 'db_cache_y', status: 'active', createdAt: '2025-02-01T00:00:00Z' },
        ],
        pagination: { total_count: 2, cursor: null, has_more: false, page_size: 20 },
      },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useDatabases>);
    renderWithProviders(<Databases />);
    expect(screen.getByTestId('rotate-password-db-1')).toBeInTheDocument();
    expect(screen.getByTestId('rotate-password-db-2')).toBeInTheDocument();
  });

  it('shows table header columns', () => {
    mockedUseDatabases.mockReturnValue({
      data: {
        data: [
          { id: 'db-1', clientId: 'c1', name: 'test_db', databaseType: 'mysql', username: 'db_test', status: 'active', createdAt: '2025-01-15T00:00:00Z' },
        ],
        pagination: { total_count: 1, cursor: null, has_more: false, page_size: 20 },
      },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useDatabases>);
    renderWithProviders(<Databases />);
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Type')).toBeInTheDocument();
    expect(screen.getByText('Username')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
  });

  it('does not show table when loading', () => {
    mockedUseDatabases.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useDatabases>);
    renderWithProviders(<Databases />);
    expect(screen.queryByTestId('databases-table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('databases-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('databases-error')).not.toBeInTheDocument();
  });

  it('does not show loading or empty when error occurs', () => {
    mockedUseDatabases.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('Connection refused'),
    } as unknown as ReturnType<typeof useDatabases>);
    renderWithProviders(<Databases />);
    expect(screen.queryByTestId('databases-loading')).not.toBeInTheDocument();
    expect(screen.queryByTestId('databases-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('databases-table')).not.toBeInTheDocument();
  });
});
