import { render, screen } from '@testing-library/react';
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

  it('shows Change Password form with all inputs', () => {
    render(<Settings />, { wrapper: createWrapper() });
    expect(screen.getByTestId('change-password-section')).toBeInTheDocument();
    expect(screen.getByText('Change Password')).toBeInTheDocument();
    expect(screen.getByTestId('current-password-input')).toBeInTheDocument();
    expect(screen.getByTestId('new-password-input')).toBeInTheDocument();
    expect(screen.getByTestId('confirm-password-input')).toBeInTheDocument();
  });

  it('has Update Password button disabled with coming soon note', () => {
    render(<Settings />, { wrapper: createWrapper() });
    const button = screen.getByTestId('update-password-button');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Update Password');
    expect(screen.getByText('Coming soon')).toBeInTheDocument();
  });

  it('does not show Platform Configuration section', () => {
    render(<Settings />, { wrapper: createWrapper() });
    expect(screen.queryByTestId('platform-config-section')).not.toBeInTheDocument();
  });
});
