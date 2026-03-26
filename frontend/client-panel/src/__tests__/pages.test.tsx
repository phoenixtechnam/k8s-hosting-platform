import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Layout from '../components/layout/Layout';
import Placeholder from '../pages/Placeholder';
import Dashboard from '../pages/Dashboard';
import Login from '../pages/Login';
import Domains from '../pages/Domains';
import Databases from '../pages/Databases';
import PasswordModal from '../components/PasswordModal';
import { ApiError } from '../lib/api-client';

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

vi.mock('../hooks/use-domains', () => ({
  useDomains: vi.fn(() => ({
    data: undefined,
    isLoading: true,
    isError: false,
    error: null,
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
    isLoading: true,
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

import { useDomains } from '../hooks/use-domains';
import { useDatabases } from '../hooks/use-databases';

const mockedUseDomains = vi.mocked(useDomains);
const mockedUseDatabases = vi.mocked(useDatabases);

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function renderWithProviders(ui: React.ReactElement, route = '/') {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Layout', () => {
  it('renders sidebar and header', () => {
    renderWithProviders(<Layout />);
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('menu-button')).toBeInTheDocument();
  });

  it('shows sidebar nav items for client panel', () => {
    renderWithProviders(<Layout />);
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Domains')).toBeInTheDocument();
    expect(screen.getByText('Databases')).toBeInTheDocument();
    expect(screen.getByText('Files')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
    expect(screen.getByText('Backups')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('shows Client Portal brand name', () => {
    renderWithProviders(<Layout />);
    expect(screen.getByText('Client Portal')).toBeInTheDocument();
  });

  it('renders the layout container', () => {
    renderWithProviders(<Layout />);
    expect(screen.getByTestId('layout')).toBeInTheDocument();
  });
});

describe('Placeholder', () => {
  it('renders with provided title', () => {
    renderWithProviders(<Placeholder title="Domains" />);
    expect(screen.getByText('Domains')).toBeInTheDocument();
    expect(screen.getByText('This page is coming soon.')).toBeInTheDocument();
  });
});

describe('Dashboard', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders welcome heading', () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByTestId('welcome-heading')).toBeInTheDocument();
    expect(screen.getByText(/Welcome back/)).toBeInTheDocument();
  });

  it('renders quick stats grid', () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByTestId('quick-stats')).toBeInTheDocument();
    expect(screen.getByText('Domains')).toBeInTheDocument();
    expect(screen.getByText('Databases')).toBeInTheDocument();
    expect(screen.getByText('Backups')).toBeInTheDocument();
    expect(screen.getByText('Workloads')).toBeInTheDocument();
  });

  it('renders getting started section', () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByText('Getting Started')).toBeInTheDocument();
  });
});

describe('Login', () => {
  it('renders login form', () => {
    renderWithProviders(<Login />);
    expect(screen.getByText('Client Portal')).toBeInTheDocument();
    expect(screen.getByText('Sign in to manage your hosting')).toBeInTheDocument();
    expect(screen.getByTestId('login-form')).toBeInTheDocument();
    expect(screen.getByTestId('email-input')).toBeInTheDocument();
    expect(screen.getByTestId('password-input')).toBeInTheDocument();
    expect(screen.getByTestId('login-button')).toBeInTheDocument();
  });
});

describe('ApiError', () => {
  it('creates an error with status and code', () => {
    const error = new ApiError(401, 'UNAUTHORIZED', 'Invalid credentials');
    expect(error.status).toBe(401);
    expect(error.code).toBe('UNAUTHORIZED');
    expect(error.message).toBe('Invalid credentials');
    expect(error.name).toBe('ApiError');
  });
});

describe('Domains', () => {
  it('renders the heading', () => {
    mockedUseDomains.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useDomains>);
    renderWithProviders(<Domains />);
    expect(screen.getByTestId('domains-heading')).toBeInTheDocument();
    expect(screen.getByText('Domains')).toBeInTheDocument();
  });

  it('shows loading state', () => {
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

  it('shows empty state when no domains', () => {
    mockedUseDomains.mockReturnValue({
      data: { data: [], pagination: { total_count: 0, cursor: null, has_more: false, page_size: 20 } },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useDomains>);
    renderWithProviders(<Domains />);
    expect(screen.getByTestId('domains-empty')).toBeInTheDocument();
    expect(screen.getByText('No domains yet')).toBeInTheDocument();
  });

  it('shows error state', () => {
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

  it('renders domain rows when data is present', () => {
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
    expect(screen.getByText('example.com')).toBeInTheDocument();
    expect(screen.getByText('test.org')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
  });
});

describe('Databases', () => {
  it('renders the heading', () => {
    mockedUseDatabases.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useDatabases>);
    renderWithProviders(<Databases />);
    expect(screen.getByTestId('databases-heading')).toBeInTheDocument();
    expect(screen.getByText('Databases')).toBeInTheDocument();
  });

  it('shows loading state', () => {
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

  it('shows empty state when no databases', () => {
    mockedUseDatabases.mockReturnValue({
      data: { data: [], pagination: { total_count: 0, cursor: null, has_more: false, page_size: 20 } },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useDatabases>);
    renderWithProviders(<Databases />);
    expect(screen.getByTestId('databases-empty')).toBeInTheDocument();
    expect(screen.getByText('No databases yet')).toBeInTheDocument();
  });

  it('shows error state', () => {
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

  it('renders database rows when data is present', () => {
    mockedUseDatabases.mockReturnValue({
      data: {
        data: [
          { id: '1', clientId: 'c1', name: 'wp_main', databaseType: 'MariaDB', username: 'db_wp_main_abc', status: 'active', createdAt: '2025-01-15T00:00:00Z' },
          { id: '2', clientId: 'c1', name: 'cache_store', databaseType: 'Redis', username: 'db_cache_xyz', status: 'active', createdAt: '2025-03-01T00:00:00Z' },
        ],
        pagination: { total_count: 2, cursor: null, has_more: false, page_size: 20 },
      },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useDatabases>);
    renderWithProviders(<Databases />);
    expect(screen.getByTestId('databases-table')).toBeInTheDocument();
    expect(screen.getByText('wp_main')).toBeInTheDocument();
    expect(screen.getByText('cache_store')).toBeInTheDocument();
    expect(screen.getByText('MariaDB')).toBeInTheDocument();
    expect(screen.getByText('Redis')).toBeInTheDocument();
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

  it('shows username column in table', () => {
    mockedUseDatabases.mockReturnValue({
      data: {
        data: [
          { id: '1', clientId: 'c1', name: 'wp_main', databaseType: 'mysql', username: 'db_wp_main_abc12345', status: 'active', createdAt: '2025-01-15T00:00:00Z' },
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

  it('shows Rotate Password button for each database row', () => {
    mockedUseDatabases.mockReturnValue({
      data: {
        data: [
          { id: 'db-1', clientId: 'c1', name: 'app_db', databaseType: 'mysql', username: 'db_app_db_x', status: 'active', createdAt: '2025-01-15T00:00:00Z' },
        ],
        pagination: { total_count: 1, cursor: null, has_more: false, page_size: 20 },
      },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useDatabases>);
    renderWithProviders(<Databases />);
    expect(screen.getByTestId('rotate-password-db-1')).toBeInTheDocument();
    expect(screen.getByText('Rotate Password')).toBeInTheDocument();
  });
});

describe('PasswordModal', () => {
  it('renders when open', () => {
    renderWithProviders(
      <PasswordModal open={true} onClose={vi.fn()} databaseName="my_db" password="s3cret123" />,
    );
    expect(screen.getByTestId('password-modal')).toBeInTheDocument();
    expect(screen.getByTestId('password-modal-value')).toHaveTextContent('s3cret123');
    expect(screen.getByTestId('password-modal-close')).toBeInTheDocument();
    expect(screen.getByTestId('password-modal-copy')).toBeInTheDocument();
  });

  it('is hidden when closed', () => {
    renderWithProviders(
      <PasswordModal open={false} onClose={vi.fn()} databaseName="my_db" password="s3cret123" />,
    );
    expect(screen.queryByTestId('password-modal')).not.toBeInTheDocument();
  });

  it('shows database name in title', () => {
    renderWithProviders(
      <PasswordModal open={true} onClose={vi.fn()} databaseName="wp_production" password="abc" />,
    );
    expect(screen.getByText(/wp_production/)).toBeInTheDocument();
  });

  it('shows warning text about saving the password', () => {
    renderWithProviders(
      <PasswordModal open={true} onClose={vi.fn()} databaseName="test_db" password="pw123" />,
    );
    expect(screen.getByText('Save this password now. It cannot be retrieved again.')).toBeInTheDocument();
  });
});
