import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Settings from '../pages/Settings';

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

describe('Client Settings page', () => {
  it('renders heading "Account Settings"', () => {
    render(<Settings />, { wrapper: createWrapper() });
    expect(screen.getByTestId('settings-heading')).toBeInTheDocument();
    expect(screen.getByText('Account Settings')).toBeInTheDocument();
  });

  it('shows Profile section with user info', () => {
    render(<Settings />, { wrapper: createWrapper() });
    expect(screen.getByTestId('profile-section')).toBeInTheDocument();
    expect(screen.getByText('Profile')).toBeInTheDocument();
    expect(screen.getByTestId('profile-name')).toHaveTextContent('Test User');
    expect(screen.getByTestId('profile-email')).toHaveTextContent('test@example.com');
    expect(screen.getByTestId('profile-role')).toHaveTextContent('client');
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

  it('does not show Platform Configuration section', () => {
    render(<Settings />, { wrapper: createWrapper() });
    expect(screen.queryByTestId('platform-config-section')).not.toBeInTheDocument();
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
});
