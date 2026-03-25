import { render, screen } from '@testing-library/react';
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

  it('shows Change Password form', () => {
    render(<Settings />, { wrapper: createWrapper() });
    expect(screen.getByTestId('change-password-section')).toBeInTheDocument();
    expect(screen.getByText('Change Password')).toBeInTheDocument();
    expect(screen.getByTestId('current-password-input')).toBeInTheDocument();
    expect(screen.getByTestId('new-password-input')).toBeInTheDocument();
    expect(screen.getByTestId('confirm-password-input')).toBeInTheDocument();
  });

  it('has Update Password button disabled', () => {
    render(<Settings />, { wrapper: createWrapper() });
    const button = screen.getByTestId('update-password-button');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Update Password');
  });

  it('shows "Coming soon" note for password change', () => {
    render(<Settings />, { wrapper: createWrapper() });
    expect(screen.getByText('Coming soon')).toBeInTheDocument();
  });
});
