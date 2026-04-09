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

vi.mock('../hooks/use-client-context', () => ({
  useClientContext: vi.fn(() => ({
    clientId: 'client-1',
    clientName: 'Test Company',
    isLoading: false,
  })),
}));

vi.mock('../hooks/use-subscription', () => ({
  useSubscription: vi.fn(() => ({
    data: {
      data: {
        client_id: 'client-1',
        status: 'active',
        subscription_expires_at: '2027-01-01T00:00:00.000Z',
        created_at: '2026-01-01T00:00:00.000Z',
        plan: {
          id: 'plan-1',
          code: 'starter',
          name: 'Starter',
          description: 'Starter plan',
          cpuLimit: '1.00',
          memoryLimit: '2.00',
          storageLimit: '20.00',
          monthlyPriceUsd: '10.00',
          maxSubUsers: 3,
          maxMailboxes: 50,
          status: 'active',
        },
      },
    },
    isLoading: false,
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

  it('shows Subscription section with plan details from useSubscription hook', () => {
    render(<Settings />, { wrapper: createWrapper() });
    expect(screen.getByTestId('subscription-section')).toBeInTheDocument();
    expect(screen.getByText('Subscription')).toBeInTheDocument();
    // Round-4 Phase C: real plan data now renders
    expect(screen.getByTestId('subscription-details')).toBeInTheDocument();
    expect(screen.getByTestId('subscription-plan-name')).toHaveTextContent('Starter');
    expect(screen.getByTestId('subscription-status')).toHaveTextContent('active');
    expect(screen.getByTestId('subscription-expires')).toBeInTheDocument();
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
