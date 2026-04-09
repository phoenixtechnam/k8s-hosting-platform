import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ClientUsersTab from '../components/ClientUsersTab';

const createMutate = vi.fn();
const updateMutate = vi.fn();
const resetMutate = vi.fn();
const resetResetFn = vi.fn();
const deleteMutate = vi.fn();
let resetIsSuccess = false;

vi.mock('../hooks/use-sub-users', () => ({
  useAdminSubUsers: vi.fn(() => ({
    data: { data: [] },
    isLoading: false,
    isError: false,
  })),
  useAdminCreateSubUser: vi.fn(() => ({
    mutateAsync: createMutate,
    isPending: false,
    error: null,
  })),
  useAdminUpdateSubUser: vi.fn(() => ({
    mutateAsync: updateMutate,
    isPending: false,
    error: null,
  })),
  useAdminResetSubUserPassword: vi.fn(() => ({
    mutateAsync: resetMutate,
    reset: resetResetFn,
    isPending: false,
    isSuccess: resetIsSuccess,
    error: null,
  })),
  useAdminDeleteSubUser: vi.fn(() => ({
    mutateAsync: deleteMutate,
    isPending: false,
  })),
}));

import { useAdminSubUsers } from '../hooks/use-sub-users';
const mockedUseAdminSubUsers = vi.mocked(useAdminSubUsers);

function createWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('ClientUsersTab', () => {
  beforeEach(() => {
    createMutate.mockReset();
    updateMutate.mockReset();
    resetMutate.mockReset();
    resetResetFn.mockReset();
    deleteMutate.mockReset();
    resetIsSuccess = false;
    mockedUseAdminSubUsers.mockReturnValue({
      data: { data: [] },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useAdminSubUsers>);
  });

  it('renders an empty state when the client has no sub-users', () => {
    render(<ClientUsersTab clientId="c1" />, { wrapper: createWrapper() });
    expect(screen.getByTestId('client-users-empty')).toBeInTheDocument();
    expect(screen.getByText(/No team members yet/)).toBeInTheDocument();
  });

  it('renders a loading state', () => {
    mockedUseAdminSubUsers.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as unknown as ReturnType<typeof useAdminSubUsers>);
    render(<ClientUsersTab clientId="c1" />, { wrapper: createWrapper() });
    expect(screen.getByTestId('client-users-loading')).toBeInTheDocument();
  });

  it('renders an error state', () => {
    mockedUseAdminSubUsers.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as unknown as ReturnType<typeof useAdminSubUsers>);
    render(<ClientUsersTab clientId="c1" />, { wrapper: createWrapper() });
    expect(screen.getByTestId('client-users-error')).toBeInTheDocument();
  });

  describe('with users', () => {
    beforeEach(() => {
      mockedUseAdminSubUsers.mockReturnValue({
        data: {
          data: [
            {
              id: 'u1',
              fullName: 'Alice',
              email: 'alice@c1.com',
              roleName: 'client_admin',
              status: 'active',
              createdAt: '2026-01-01T00:00:00Z',
              lastLoginAt: null,
            },
            {
              id: 'u2',
              fullName: 'Bob',
              email: 'bob@c1.com',
              roleName: 'client_user',
              status: 'disabled',
              createdAt: '2026-01-02T00:00:00Z',
              lastLoginAt: null,
            },
          ],
        },
        isLoading: false,
        isError: false,
      } as unknown as ReturnType<typeof useAdminSubUsers>);
    });

    it('renders the user table with both rows', () => {
      render(<ClientUsersTab clientId="c1" />, { wrapper: createWrapper() });
      expect(screen.getByTestId('client-users-table')).toBeInTheDocument();
      expect(screen.getByText('Alice')).toBeInTheDocument();
      expect(screen.getByText('Bob')).toBeInTheDocument();
    });

    it('renders all row action buttons', () => {
      render(<ClientUsersTab clientId="c1" />, { wrapper: createWrapper() });
      expect(screen.getByTestId('client-users-edit-u1')).toBeInTheDocument();
      expect(screen.getByTestId('client-users-reset-u1')).toBeInTheDocument();
      expect(screen.getByTestId('client-users-toggle-u1')).toBeInTheDocument();
      expect(screen.getByTestId('client-users-delete-u1')).toBeInTheDocument();
    });

    it('opens the Add User form and calls the create mutation', async () => {
      createMutate.mockResolvedValueOnce({ data: { id: 'u-new' } });
      const user = userEvent.setup();
      render(<ClientUsersTab clientId="c1" />, { wrapper: createWrapper() });
      await user.click(screen.getByTestId('client-users-add-button'));
      expect(screen.getByTestId('client-users-create-form')).toBeInTheDocument();
      await user.type(screen.getByTestId('client-users-name-input'), 'Charlie');
      await user.type(screen.getByTestId('client-users-email-input'), 'charlie@c1.com');
      await user.type(screen.getByTestId('client-users-password-input'), 'password123');
      await user.click(screen.getByTestId('client-users-submit'));
      expect(createMutate).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'charlie@c1.com', role_name: 'client_user' }),
      );
    });

    it('requires confirmation before disabling an active user', async () => {
      updateMutate.mockResolvedValueOnce({ data: { id: 'u1' } });
      const user = userEvent.setup();
      render(<ClientUsersTab clientId="c1" />, { wrapper: createWrapper() });
      await user.click(screen.getByTestId('client-users-toggle-u1'));
      expect(updateMutate).not.toHaveBeenCalled();
      await user.click(screen.getByTestId('client-users-disable-confirm-u1'));
      expect(updateMutate).toHaveBeenCalledWith({
        userId: 'u1',
        patch: { status: 'disabled' },
      });
    });

    it('re-enables a disabled user without confirmation', async () => {
      updateMutate.mockResolvedValueOnce({ data: { id: 'u2' } });
      const user = userEvent.setup();
      render(<ClientUsersTab clientId="c1" />, { wrapper: createWrapper() });
      await user.click(screen.getByTestId('client-users-toggle-u2'));
      expect(updateMutate).toHaveBeenCalledWith({
        userId: 'u2',
        patch: { status: 'active' },
      });
    });

    it('opens the edit modal and sends only changed fields', async () => {
      updateMutate.mockResolvedValueOnce({ data: { id: 'u1' } });
      const user = userEvent.setup();
      render(<ClientUsersTab clientId="c1" />, { wrapper: createWrapper() });
      await user.click(screen.getByTestId('client-users-edit-u1'));
      expect(screen.getByTestId('client-users-edit-modal')).toBeInTheDocument();
      const nameInput = screen.getByTestId('client-users-edit-name-input');
      await user.clear(nameInput);
      await user.type(nameInput, 'Alice Renamed');
      await user.click(screen.getByTestId('client-users-edit-save'));
      expect(updateMutate).toHaveBeenCalledWith({
        userId: 'u1',
        patch: { full_name: 'Alice Renamed' },
      });
    });

    it('opens the reset password modal and validates mismatch', async () => {
      const user = userEvent.setup();
      render(<ClientUsersTab clientId="c1" />, { wrapper: createWrapper() });
      await user.click(screen.getByTestId('client-users-reset-u1'));
      expect(screen.getByTestId('client-users-reset-modal')).toBeInTheDocument();
      await user.type(screen.getByTestId('client-users-reset-new-input'), 'password123');
      await user.type(screen.getByTestId('client-users-reset-confirm-input'), 'different999');
      await user.click(screen.getByTestId('client-users-reset-save'));
      expect(screen.getByTestId('client-users-reset-mismatch-error')).toBeInTheDocument();
      expect(resetMutate).not.toHaveBeenCalled();
    });

    it('calls the reset-password mutation with matching passwords', async () => {
      resetMutate.mockResolvedValueOnce(undefined);
      const user = userEvent.setup();
      render(<ClientUsersTab clientId="c1" />, { wrapper: createWrapper() });
      await user.click(screen.getByTestId('client-users-reset-u1'));
      await user.type(screen.getByTestId('client-users-reset-new-input'), 'brand-new-pw-123');
      await user.type(screen.getByTestId('client-users-reset-confirm-input'), 'brand-new-pw-123');
      await user.click(screen.getByTestId('client-users-reset-save'));
      expect(resetMutate).toHaveBeenCalledWith({
        userId: 'u1',
        newPassword: 'brand-new-pw-123',
      });
    });

    it('shows reset success state after opening the modal when isSuccess=true', async () => {
      resetIsSuccess = true;
      const user = userEvent.setup();
      render(<ClientUsersTab clientId="c1" />, { wrapper: createWrapper() });
      await user.click(screen.getByTestId('client-users-reset-u1'));
      // Modal must be open AND showing the success branch
      expect(screen.getByTestId('client-users-reset-modal')).toBeInTheDocument();
      expect(screen.getByTestId('client-users-reset-success')).toBeInTheDocument();
      expect(screen.getByText(/Password updated for/)).toBeInTheDocument();
      // The success branch has a Done button, not Save
      expect(screen.getByTestId('client-users-reset-done')).toBeInTheDocument();
      expect(screen.queryByTestId('client-users-reset-save')).not.toBeInTheDocument();
      // Clicking Done should reset the mutation state and close the modal
      await user.click(screen.getByTestId('client-users-reset-done'));
      expect(resetResetFn).toHaveBeenCalled();
    });

    it('requires confirmation before deleting', async () => {
      deleteMutate.mockResolvedValueOnce(undefined);
      const user = userEvent.setup();
      render(<ClientUsersTab clientId="c1" />, { wrapper: createWrapper() });
      await user.click(screen.getByTestId('client-users-delete-u1'));
      expect(deleteMutate).not.toHaveBeenCalled();
      await user.click(screen.getByTestId('client-users-delete-confirm-u1'));
      expect(deleteMutate).toHaveBeenCalledWith('u1');
    });
  });
});
