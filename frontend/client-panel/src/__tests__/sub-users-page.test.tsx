import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import SubUsers from '../pages/SubUsers';

// Phase 1: SubUsers reads `useAuth((s) => s.user)` via the zustand
// selector overload. Mock it so both the call shape (with a selector)
// and the no-arg shape resolve to the same user object — tests can
// flip `mockUser.role` in `beforeEach` to exercise role gating.
const mockUser = {
  id: 'client-1',
  email: 'test@example.com',
  fullName: 'Test User',
  role: 'client_admin',
  panel: 'client',
  clientId: 'client-1',
};
vi.mock('../hooks/use-auth', () => ({
  useAuth: <T,>(selector?: (state: { user: typeof mockUser }) => T) => {
    const state = { user: mockUser };
    return selector ? selector(state) : state;
  },
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
  beforeEach(() => {
    // Default role for the shared tests; individual suites override.
    mockUser.role = 'client_admin';
    mockedUseSubUsers.mockReturnValue({
      data: { data: [] },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useSubUsers>);
  });

  it('renders the heading', () => {
    renderWithProviders(<SubUsers />);
    expect(screen.getByTestId('sub-users-heading')).toBeInTheDocument();
    expect(screen.getByText('Users')).toBeInTheDocument();
  });

  it('renders description text', () => {
    renderWithProviders(<SubUsers />);
    expect(screen.getByText('Manage users who can access your account.')).toBeInTheDocument();
  });

  it('renders Add User button for client_admin', () => {
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

  // ─── Phase 1 role gating ───────────────────────────────────────────

  describe('as client_admin', () => {
    beforeEach(() => {
      mockUser.role = 'client_admin';
      mockedUseSubUsers.mockReturnValue({
        data: {
          data: [
            {
              id: 'u-admin',
              fullName: 'Admin User',
              email: 'admin@c1.com',
              roleName: 'client_admin',
              status: 'active',
              lastLoginAt: null,
            },
            {
              id: 'u-member',
              fullName: 'Team Member',
              email: 'member@c1.com',
              roleName: 'client_user',
              status: 'active',
              lastLoginAt: null,
            },
          ],
        },
        isLoading: false,
        isError: false,
        error: null,
      } as unknown as ReturnType<typeof useSubUsers>);
    });

    it('shows per-row delete buttons', () => {
      renderWithProviders(<SubUsers />);
      expect(screen.getByTestId('delete-user-u-admin')).toBeInTheDocument();
      expect(screen.getByTestId('delete-user-u-member')).toBeInTheDocument();
    });

    it('does not show the read-only notice', () => {
      renderWithProviders(<SubUsers />);
      expect(screen.queryByTestId('read-only-notice')).not.toBeInTheDocument();
    });
  });

  describe('as client_user (read-only)', () => {
    beforeEach(() => {
      mockUser.role = 'client_user';
      mockedUseSubUsers.mockReturnValue({
        data: {
          data: [
            {
              id: 'u-admin',
              fullName: 'Admin User',
              email: 'admin@c1.com',
              roleName: 'client_admin',
              status: 'active',
              lastLoginAt: null,
            },
            {
              id: 'u-member',
              fullName: 'Team Member',
              email: 'member@c1.com',
              roleName: 'client_user',
              status: 'active',
              lastLoginAt: null,
            },
          ],
        },
        isLoading: false,
        isError: false,
        error: null,
      } as unknown as ReturnType<typeof useSubUsers>);
    });

    it('still renders the user list (regression: the /users page used to 403 for this role)', () => {
      renderWithProviders(<SubUsers />);
      expect(screen.getByTestId('sub-users-heading')).toBeInTheDocument();
      expect(screen.getByText('Admin User')).toBeInTheDocument();
      expect(screen.getByText('Team Member')).toBeInTheDocument();
    });

    it('hides the Add User button', () => {
      renderWithProviders(<SubUsers />);
      expect(screen.queryByTestId('add-user-button')).not.toBeInTheDocument();
    });

    it('hides per-row delete buttons', () => {
      renderWithProviders(<SubUsers />);
      expect(screen.queryByTestId('delete-user-u-admin')).not.toBeInTheDocument();
      expect(screen.queryByTestId('delete-user-u-member')).not.toBeInTheDocument();
    });

    it('shows the read-only notice', () => {
      renderWithProviders(<SubUsers />);
      expect(screen.getByTestId('read-only-notice')).toBeInTheDocument();
      expect(screen.getByText(/read-only access/i)).toBeInTheDocument();
    });
  });
});
