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

  it('shows Subscription section', () => {
    render(<Settings />, { wrapper: createWrapper() });
    expect(screen.getByTestId('subscription-section')).toBeInTheDocument();
    expect(screen.getByText('Subscription')).toBeInTheDocument();
    expect(screen.getByText('Standard')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows Notification Preferences section', () => {
    render(<Settings />, { wrapper: createWrapper() });
    expect(screen.getByTestId('notification-prefs-section')).toBeInTheDocument();
    expect(screen.getByText('Notification Preferences')).toBeInTheDocument();
  });

  it('does not show Profile section (moved to user menu)', () => {
    render(<Settings />, { wrapper: createWrapper() });
    expect(screen.queryByTestId('profile-section')).not.toBeInTheDocument();
  });

  it('does not show Change Password section (moved to user menu)', () => {
    render(<Settings />, { wrapper: createWrapper() });
    expect(screen.queryByTestId('change-password-section')).not.toBeInTheDocument();
  });

  it('does not show Platform Configuration section', () => {
    render(<Settings />, { wrapper: createWrapper() });
    expect(screen.queryByTestId('platform-config-section')).not.toBeInTheDocument();
  });
});
