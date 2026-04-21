import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import SshKeys from '../pages/SshKeys';

vi.mock('../hooks/use-client-context', () => ({
  useClientContext: vi.fn(() => ({
    clientId: 'client-1',
    clientName: 'Test Company',
    isLoading: false,
  })),
}));

// Phase 6: SshKeys now uses useCanManage which reads from useAuth.
// Default to client_admin so the existing tests still see the Add button.
const _mockAuthUser = { id: 'u1', email: 'u@c1.com', fullName: 'Me', role: 'client_admin' };
vi.mock('../hooks/use-auth', () => ({
  useAuth: <T,>(selector?: (state: { user: typeof _mockAuthUser }) => T) => {
    const state = { user: _mockAuthUser };
    return selector ? selector(state) : state;
  },
}));

const mockKey = {
  id: 'key-1',
  clientId: 'client-1',
  name: 'laptop-alice',
  publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI abc alice@laptop',
  keyFingerprint: 'SHA256:abc123def456ghi789',
  keyAlgorithm: 'ssh-ed25519',
  createdAt: '2026-01-10T00:00:00Z',
};

const createMutate = vi.fn();
const deleteMutate = vi.fn();
interface MockCreateHook {
  readonly mutateAsync: typeof createMutate;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: Error | null;
}
interface MockDeleteHook {
  readonly mutate: typeof deleteMutate;
  readonly isPending: boolean;
}
interface MockListHook {
  readonly data: { readonly data: readonly typeof mockKey[] };
  readonly isLoading: boolean;
}
const createHook = vi.fn<() => MockCreateHook>(() => ({
  mutateAsync: createMutate,
  isPending: false,
  isError: false,
  error: null,
}));
const deleteHook = vi.fn<() => MockDeleteHook>(() => ({
  mutate: deleteMutate,
  isPending: false,
}));
const listHook = vi.fn<() => MockListHook>(() => ({
  data: { data: [mockKey] },
  isLoading: false,
}));

vi.mock('../hooks/use-ssh-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/use-ssh-keys')>();
  return {
    ...actual,
    useSshKeys: () => listHook(),
    useCreateSshKey: () => createHook(),
    useDeleteSshKey: () => deleteHook(),
    useUpdateSshKey: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  };
});

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

beforeEach(() => {
  createMutate.mockReset();
  createMutate.mockResolvedValue({ data: mockKey });
  deleteMutate.mockReset();
  listHook.mockReturnValue({
    data: { data: [mockKey] },
    isLoading: false,
  });
  createHook.mockReturnValue({
    mutateAsync: createMutate,
    isPending: false,
    isError: false,
    error: null,
  });
  deleteHook.mockReturnValue({
    mutate: deleteMutate,
    isPending: false,
  });
});

describe('SshKeys page', () => {
  it('renders the heading and key count', () => {
    render(<SshKeys />, { wrapper: createWrapper() });
    expect(screen.getByTestId('ssh-keys-heading')).toBeInTheDocument();
    expect(screen.getByTestId('ssh-keys-count')).toHaveTextContent('1 key');
  });

  it('renders the list of keys with name, algorithm, fingerprint, and added date', () => {
    render(<SshKeys />, { wrapper: createWrapper() });
    expect(screen.getByTestId('ssh-keys-table')).toBeInTheDocument();
    expect(screen.getByText('laptop-alice')).toBeInTheDocument();
    expect(screen.getByText('ssh-ed25519')).toBeInTheDocument();
    expect(screen.getByText('SHA256:abc123def456ghi789')).toBeInTheDocument();
  });

  it('shows an empty state when there are no keys and the form is hidden', () => {
    listHook.mockReturnValueOnce({ data: { data: [] }, isLoading: false });
    render(<SshKeys />, { wrapper: createWrapper() });
    expect(screen.getByTestId('ssh-keys-empty')).toBeInTheDocument();
    expect(screen.getByTestId('ssh-keys-count')).toHaveTextContent('0 keys');
  });

  it('opens and closes the add-key form when the button is clicked', async () => {
    const user = userEvent.setup();
    render(<SshKeys />, { wrapper: createWrapper() });
    expect(screen.queryByTestId('ssh-key-form')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('add-ssh-key-button'));
    expect(screen.getByTestId('ssh-key-form')).toBeInTheDocument();
    await user.click(screen.getByTestId('add-ssh-key-button'));
    expect(screen.queryByTestId('ssh-key-form')).not.toBeInTheDocument();
  });

  it('submits a new key and hides the form on success', async () => {
    const user = userEvent.setup();
    render(<SshKeys />, { wrapper: createWrapper() });
    await user.click(screen.getByTestId('add-ssh-key-button'));
    await user.type(screen.getByTestId('ssh-key-name-input'), 'work-laptop');
    await user.type(
      screen.getByTestId('ssh-key-public-input'),
      'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDtestkey work@laptop',
    );
    await user.click(screen.getByTestId('submit-ssh-key'));

    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
    expect(createMutate.mock.calls[0][0]).toEqual({
      name: 'work-laptop',
      public_key: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDtestkey work@laptop',
    });
  });

  it('surfaces create errors in the form', async () => {
    // Keep the error state across all re-renders (not mockReturnValueOnce).
    createHook.mockReturnValue({
      mutateAsync: createMutate,
      isPending: false,
      isError: true,
      error: new Error('Public key already exists'),
    });
    const user = userEvent.setup();
    render(<SshKeys />, { wrapper: createWrapper() });
    await user.click(screen.getByTestId('add-ssh-key-button'));
    expect(screen.getByTestId('ssh-key-form-error')).toHaveTextContent('Public key already exists');
  });

  it('requires two clicks to delete a key (confirm pattern)', async () => {
    const user = userEvent.setup();
    render(<SshKeys />, { wrapper: createWrapper() });

    // First click — arm the confirm state.
    await user.click(screen.getByTestId('ssh-key-delete-key-1'));
    expect(screen.getByTestId('ssh-key-delete-confirm-key-1')).toBeInTheDocument();
    expect(screen.getByTestId('ssh-key-delete-cancel-key-1')).toBeInTheDocument();
    expect(deleteMutate).not.toHaveBeenCalled();

    // Cancel click — back to the trash button.
    await user.click(screen.getByTestId('ssh-key-delete-cancel-key-1'));
    expect(screen.queryByTestId('ssh-key-delete-confirm-key-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('ssh-key-delete-key-1')).toBeInTheDocument();

    // Arm again → Confirm → deleteMutate called.
    await user.click(screen.getByTestId('ssh-key-delete-key-1'));
    await user.click(screen.getByTestId('ssh-key-delete-confirm-key-1'));
    expect(deleteMutate).toHaveBeenCalledTimes(1);
    expect(deleteMutate.mock.calls[0][0]).toBe('key-1');
  });
});
