import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Settings from '../pages/Settings';

vi.mock('../hooks/use-auth', () => ({
  useAuth: vi.fn(() => ({
    user: { id: 'admin-1', email: 'admin@platform.local', fullName: 'Admin User', role: 'admin' },
    token: 'test-token',
    isAuthenticated: true,
    isLoading: false,
    error: null,
    login: vi.fn(),
    logout: vi.fn(),
    initialize: vi.fn(),
  })),
}));

vi.mock('../hooks/use-password', () => ({
  useChangePassword: vi.fn(() => ({
    mutateAsync: vi.fn().mockResolvedValue({ data: { message: 'Password updated successfully' } }),
    isPending: false,
  })),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('Admin Settings page', () => {
  it('renders heading "Settings"', () => {
    render(<Settings />, { wrapper: createWrapper() });
    expect(screen.getByTestId('settings-heading')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('shows Profile section with user info', () => {
    render(<Settings />, { wrapper: createWrapper() });
    expect(screen.getByTestId('profile-section')).toBeInTheDocument();
    expect(screen.getByText('Profile')).toBeInTheDocument();
    expect(screen.getByTestId('profile-name')).toHaveTextContent('Admin User');
    expect(screen.getByTestId('profile-email')).toHaveTextContent('admin@platform.local');
    expect(screen.getByTestId('profile-role')).toHaveTextContent('admin');
  });

  it('shows Platform Configuration section', () => {
    render(<Settings />, { wrapper: createWrapper() });
    expect(screen.getByTestId('platform-config-section')).toBeInTheDocument();
    expect(screen.getByText('Platform Configuration')).toBeInTheDocument();
    expect(screen.getByText('K8s Hosting Platform')).toBeInTheDocument();
    expect(screen.getByText('0.1.0')).toBeInTheDocument();
    expect(screen.getByText('Production')).toBeInTheDocument();
    expect(screen.getByText('24 hours')).toBeInTheDocument();
    expect(screen.getByText('100 req/min')).toBeInTheDocument();
  });

  it('shows environment variables note in Platform Configuration', () => {
    render(<Settings />, { wrapper: createWrapper() });
    expect(screen.getByText('Configuration is managed via environment variables.')).toBeInTheDocument();
  });

  it('shows Change Password form with enabled inputs', () => {
    render(<Settings />, { wrapper: createWrapper() });
    expect(screen.getByTestId('change-password-section')).toBeInTheDocument();
    expect(screen.getByText('Change Password')).toBeInTheDocument();
    expect(screen.getByTestId('current-password-input')).toBeEnabled();
    expect(screen.getByTestId('new-password-input')).toBeEnabled();
    expect(screen.getByTestId('confirm-password-input')).toBeEnabled();
  });

  it('has Update Password button enabled', () => {
    render(<Settings />, { wrapper: createWrapper() });
    const button = screen.getByTestId('update-password-button');
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent('Update Password');
  });

  it('shows mismatch error when passwords do not match', async () => {
    const user = userEvent.setup();
    render(<Settings />, { wrapper: createWrapper() });

    await user.type(screen.getByTestId('current-password-input'), 'oldpass');
    await user.type(screen.getByTestId('new-password-input'), 'newpass1');
    await user.type(screen.getByTestId('confirm-password-input'), 'newpass2');
    await user.click(screen.getByTestId('update-password-button'));

    expect(screen.getByTestId('password-error-message')).toHaveTextContent('New passwords do not match');
  });

  it('shows success message after successful password change', async () => {
    const user = userEvent.setup();
    render(<Settings />, { wrapper: createWrapper() });

    await user.type(screen.getByTestId('current-password-input'), 'oldpass');
    await user.type(screen.getByTestId('new-password-input'), 'newpass123');
    await user.type(screen.getByTestId('confirm-password-input'), 'newpass123');
    await user.click(screen.getByTestId('update-password-button'));

    expect(screen.getByTestId('password-success-message')).toHaveTextContent('Password updated successfully');
  });

  it('clears form fields after successful password change', async () => {
    const user = userEvent.setup();
    render(<Settings />, { wrapper: createWrapper() });

    const currentInput = screen.getByTestId('current-password-input');
    const newInput = screen.getByTestId('new-password-input');
    const confirmInput = screen.getByTestId('confirm-password-input');

    await user.type(currentInput, 'oldpass');
    await user.type(newInput, 'newpass123');
    await user.type(confirmInput, 'newpass123');
    await user.click(screen.getByTestId('update-password-button'));

    expect(currentInput).toHaveValue('');
    expect(newInput).toHaveValue('');
    expect(confirmInput).toHaveValue('');
  });
});
