import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import UserSettings from '../pages/UserSettings';

vi.mock('@/lib/api-client', () => ({
  API_BASE: 'http://localhost:3000',
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string) {
      super(message); this.name = 'ApiError';
    }
  },
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: vi.fn(() => ({
    user: { id: 'u1', email: 'admin@test.com', fullName: 'Admin User', role: 'admin' },
    token: 'test-token',
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    initialize: vi.fn(),
  })),
}));

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return <QueryClientProvider client={qc}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>;
  };
}

beforeEach(() => vi.clearAllMocks());

describe('UserSettings page', () => {
  it('renders heading', () => {
    render(<UserSettings />, { wrapper: createWrapper() });
    expect(screen.getByTestId('user-settings-heading')).toHaveTextContent('User Settings');
  });

  it('renders profile section with user data', () => {
    render(<UserSettings />, { wrapper: createWrapper() });
    expect(screen.getByTestId('profile-section')).toBeInTheDocument();
    expect(screen.getByTestId('profile-full-name')).toHaveValue('Admin User');
    expect(screen.getByTestId('profile-email')).toHaveValue('admin@test.com');
  });

  it('renders password section', () => {
    render(<UserSettings />, { wrapper: createWrapper() });
    expect(screen.getByTestId('password-section')).toBeInTheDocument();
    expect(screen.getByTestId('settings-current-password')).toBeInTheDocument();
    expect(screen.getByTestId('settings-new-password')).toBeInTheDocument();
    expect(screen.getByTestId('settings-confirm-password')).toBeInTheDocument();
  });

  it('has profile save button', () => {
    render(<UserSettings />, { wrapper: createWrapper() });
    expect(screen.getByTestId('profile-save-button')).toBeInTheDocument();
  });

  it('has update password button', () => {
    render(<UserSettings />, { wrapper: createWrapper() });
    expect(screen.getByTestId('settings-update-password-button')).toBeInTheDocument();
  });

  it('shows password mismatch error', async () => {
    const user = userEvent.setup();
    render(<UserSettings />, { wrapper: createWrapper() });

    await user.type(screen.getByTestId('settings-current-password'), 'current');
    await user.type(screen.getByTestId('settings-new-password'), 'newpass123');
    await user.type(screen.getByTestId('settings-confirm-password'), 'different');
    await user.click(screen.getByTestId('settings-update-password-button'));

    await waitFor(() => {
      expect(screen.getByTestId('password-error')).toHaveTextContent('New passwords do not match');
    });
  });
});
