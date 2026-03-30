import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import SubUsers from '../pages/SubUsers';

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

vi.mock('../hooks/use-sub-users', () => ({
  useSubUsers: vi.fn(() => ({
    data: { data: [] },
    isLoading: false,
    isError: false,
    error: null,
  })),
  useCreateSubUser: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, error: null })),
  useDeleteSubUser: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}));

import { useSubUsers } from '../hooks/use-sub-users';

const mockedUseSubUsers = vi.mocked(useSubUsers);

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

describe('SubUsers Page', () => {
  it('renders the heading', () => {
    renderWithProviders(<SubUsers />);
    expect(screen.getByTestId('sub-users-heading')).toBeInTheDocument();
    expect(screen.getByText('Users')).toBeInTheDocument();
  });

  it('renders description text', () => {
    renderWithProviders(<SubUsers />);
    expect(screen.getByText('Manage users who can access your account.')).toBeInTheDocument();
  });

  it('renders Add User button', () => {
    renderWithProviders(<SubUsers />);
    expect(screen.getByTestId('add-user-button')).toBeInTheDocument();
    expect(screen.getByText('Add User')).toBeInTheDocument();
  });

  it('shows empty state when no users', () => {
    renderWithProviders(<SubUsers />);
    expect(screen.getByText('No sub-users yet')).toBeInTheDocument();
    expect(screen.getByText('Add users to give team members access.')).toBeInTheDocument();
  });

  it('shows users table when data is present', () => {
    mockedUseSubUsers.mockReturnValue({
      data: {
        data: [
          {
            id: 'u1',
            fullName: 'Jane Doe',
            email: 'jane@example.com',
            roleName: 'editor',
            status: 'active',
            lastLoginAt: '2026-03-20T10:00:00Z',
          },
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useSubUsers>);

    renderWithProviders(<SubUsers />);
    expect(screen.getByTestId('users-table')).toBeInTheDocument();
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('jane@example.com')).toBeInTheDocument();
    expect(screen.getByText('editor')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('shows error state on fetch failure', () => {
    mockedUseSubUsers.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('Network error'),
    } as unknown as ReturnType<typeof useSubUsers>);

    renderWithProviders(<SubUsers />);
    expect(screen.getByText('Failed to load users.')).toBeInTheDocument();
  });
});
