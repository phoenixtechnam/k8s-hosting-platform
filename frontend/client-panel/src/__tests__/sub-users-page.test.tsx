import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const createUserMutate = vi.fn();
const updateUserMutate = vi.fn();
const deleteUserMutate = vi.fn();
vi.mock('../hooks/use-sub-users', () => ({
  useSubUsers: vi.fn(() => ({
    data: { data: [] },
    isLoading: false,
    isError: false,
    error: null,
  })),
  useCreateSubUser: vi.fn(() => ({ mutateAsync: createUserMutate, isPending: false, error: null })),
  useUpdateSubUser: vi.fn(() => ({ mutateAsync: updateUserMutate, isPending: false, error: null })),
  useDeleteSubUser: vi.fn(() => ({ mutateAsync: deleteUserMutate, isPending: false, error: null })),
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
    createUserMutate.mockReset();
    updateUserMutate.mockReset();
    deleteUserMutate.mockReset();
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

    // ─── Phase 2 role selector ─────────────────────────────────────
    it('renders the role selector in the create form', async () => {
      const user = userEvent.setup();
      renderWithProviders(<SubUsers />);
      await user.click(screen.getByTestId('add-user-button'));
      const select = screen.getByTestId('user-role-select') as HTMLSelectElement;
      expect(select).toBeInTheDocument();
      expect(select.value).toBe('client_user'); // default
    });

    it('defaults new users to client_user', async () => {
      createUserMutate.mockResolvedValueOnce({ data: { id: 'u-new' } });
      const user = userEvent.setup();
      renderWithProviders(<SubUsers />);
      await user.click(screen.getByTestId('add-user-button'));
      await user.type(screen.getByTestId('user-name-input'), 'New Guy');
      await user.type(screen.getByTestId('user-email-input'), 'new@c1.com');
      await user.type(screen.getByTestId('user-password-input'), 'password123');
      await user.click(screen.getByTestId('submit-user'));
      expect(createUserMutate).toHaveBeenCalledWith(
        expect.objectContaining({ role_name: 'client_user' }),
      );
    });

    it('creates a client_admin when that role is selected', async () => {
      createUserMutate.mockResolvedValueOnce({ data: { id: 'u-new' } });
      const user = userEvent.setup();
      renderWithProviders(<SubUsers />);
      await user.click(screen.getByTestId('add-user-button'));
      await user.type(screen.getByTestId('user-name-input'), 'Promoted');
      await user.type(screen.getByTestId('user-email-input'), 'promo@c1.com');
      await user.type(screen.getByTestId('user-password-input'), 'password123');
      await user.selectOptions(screen.getByTestId('user-role-select'), 'client_admin');
      await user.click(screen.getByTestId('submit-user'));
      expect(createUserMutate).toHaveBeenCalledWith(
        expect.objectContaining({ role_name: 'client_admin' }),
      );
    });

    it('renders the role column as "Admin" or "Member" (not the raw enum)', () => {
      mockedUseSubUsers.mockReturnValue({
        data: {
          data: [
            { id: 'u1', fullName: 'A', email: 'a@c1.com', roleName: 'client_admin', status: 'active', lastLoginAt: null },
            { id: 'u2', fullName: 'B', email: 'b@c1.com', roleName: 'client_user', status: 'active', lastLoginAt: null },
          ],
        },
        isLoading: false, isError: false, error: null,
      } as unknown as ReturnType<typeof useSubUsers>);
      renderWithProviders(<SubUsers />);
      expect(screen.getByText('Admin')).toBeInTheDocument();
      expect(screen.getByText('Member')).toBeInTheDocument();
      expect(screen.queryByText('client_admin')).not.toBeInTheDocument();
      expect(screen.queryByText('client_user')).not.toBeInTheDocument();
    });

    // ─── Phase 3 edit / disable ────────────────────────────────────
    describe('with a row to edit', () => {
      beforeEach(() => {
        mockedUseSubUsers.mockReturnValue({
          data: {
            data: [
              {
                id: 'u1',
                fullName: 'Alice',
                email: 'alice@c1.com',
                roleName: 'client_user',
                status: 'active',
                createdAt: '2026-01-01T00:00:00Z',
                lastLoginAt: null,
              },
            ],
          },
          isLoading: false, isError: false, error: null,
        } as unknown as ReturnType<typeof useSubUsers>);
      });

      it('renders the row action buttons (edit, toggle status, delete)', () => {
        renderWithProviders(<SubUsers />);
        expect(screen.getByTestId('edit-user-u1')).toBeInTheDocument();
        expect(screen.getByTestId('toggle-status-u1')).toBeInTheDocument();
        expect(screen.getByTestId('delete-user-u1')).toBeInTheDocument();
      });

      it('opens the edit modal when the edit button is clicked', async () => {
        const user = userEvent.setup();
        renderWithProviders(<SubUsers />);
        await user.click(screen.getByTestId('edit-user-u1'));
        expect(screen.getByTestId('edit-user-modal')).toBeInTheDocument();
        expect(screen.getByTestId('edit-user-name-input')).toHaveValue('Alice');
        expect(screen.getByTestId('edit-user-email-input')).toBeDisabled();
      });

      it('sends only changed fields in the patch', async () => {
        updateUserMutate.mockResolvedValueOnce({ data: { id: 'u1' } });
        const user = userEvent.setup();
        renderWithProviders(<SubUsers />);
        await user.click(screen.getByTestId('edit-user-u1'));
        const nameInput = screen.getByTestId('edit-user-name-input');
        await user.clear(nameInput);
        await user.type(nameInput, 'Alice Renamed');
        await user.click(screen.getByTestId('edit-user-save'));
        expect(updateUserMutate).toHaveBeenCalledWith({
          userId: 'u1',
          patch: { full_name: 'Alice Renamed' },
        });
      });

      it('promotes a member to admin via the edit form', async () => {
        updateUserMutate.mockResolvedValueOnce({ data: { id: 'u1' } });
        const user = userEvent.setup();
        renderWithProviders(<SubUsers />);
        await user.click(screen.getByTestId('edit-user-u1'));
        await user.selectOptions(screen.getByTestId('edit-user-role-select'), 'client_admin');
        await user.click(screen.getByTestId('edit-user-save'));
        expect(updateUserMutate).toHaveBeenCalledWith({
          userId: 'u1',
          patch: { role_name: 'client_admin' },
        });
      });

      it('disables a user via the edit form', async () => {
        updateUserMutate.mockResolvedValueOnce({ data: { id: 'u1' } });
        const user = userEvent.setup();
        renderWithProviders(<SubUsers />);
        await user.click(screen.getByTestId('edit-user-u1'));
        await user.selectOptions(screen.getByTestId('edit-user-status-select'), 'disabled');
        await user.click(screen.getByTestId('edit-user-save'));
        expect(updateUserMutate).toHaveBeenCalledWith({
          userId: 'u1',
          patch: { status: 'disabled' },
        });
      });

      it('requires confirmation before disabling from the row button', async () => {
        updateUserMutate.mockResolvedValueOnce({ data: { id: 'u1' } });
        const user = userEvent.setup();
        renderWithProviders(<SubUsers />);
        // First click reveals the confirm prompt, does NOT fire the mutation
        await user.click(screen.getByTestId('toggle-status-u1'));
        expect(updateUserMutate).not.toHaveBeenCalled();
        expect(screen.getByTestId('disable-confirm-u1')).toBeInTheDocument();
        await user.click(screen.getByTestId('disable-confirm-yes-u1'));
        expect(updateUserMutate).toHaveBeenCalledWith({
          userId: 'u1',
          patch: { status: 'disabled' },
        });
      });

      it('closes the modal without a network call when no fields are changed', async () => {
        const user = userEvent.setup();
        renderWithProviders(<SubUsers />);
        await user.click(screen.getByTestId('edit-user-u1'));
        expect(screen.getByTestId('edit-user-modal')).toBeInTheDocument();
        await user.click(screen.getByTestId('edit-user-save'));
        expect(updateUserMutate).not.toHaveBeenCalled();
        expect(screen.queryByTestId('edit-user-modal')).not.toBeInTheDocument();
      });
    });

    describe('with a disabled row', () => {
      beforeEach(() => {
        mockedUseSubUsers.mockReturnValue({
          data: {
            data: [
              {
                id: 'u-off',
                fullName: 'Off User',
                email: 'off@c1.com',
                roleName: 'client_user',
                status: 'disabled',
                createdAt: '2026-01-01T00:00:00Z',
                lastLoginAt: null,
              },
            ],
          },
          isLoading: false, isError: false, error: null,
        } as unknown as ReturnType<typeof useSubUsers>);
      });

      it('re-enables a disabled user immediately without confirmation', async () => {
        updateUserMutate.mockResolvedValueOnce({ data: { id: 'u-off' } });
        const user = userEvent.setup();
        renderWithProviders(<SubUsers />);
        await user.click(screen.getByTestId('toggle-status-u-off'));
        expect(updateUserMutate).toHaveBeenCalledWith({
          userId: 'u-off',
          patch: { status: 'active' },
        });
      });
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
