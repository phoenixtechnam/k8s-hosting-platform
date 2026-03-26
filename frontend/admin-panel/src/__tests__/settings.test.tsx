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
  it('renders heading "Platform Settings"', () => {
    render(<Settings />, { wrapper: createWrapper() });
    expect(screen.getByTestId('settings-heading')).toBeInTheDocument();
    expect(screen.getByText('Platform Settings')).toBeInTheDocument();
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

  it('does not show Profile section (moved to user menu)', () => {
    render(<Settings />, { wrapper: createWrapper() });
    expect(screen.queryByTestId('profile-section')).not.toBeInTheDocument();
  });

  it('does not show Change Password section (moved to user menu)', () => {
    render(<Settings />, { wrapper: createWrapper() });
    expect(screen.queryByTestId('change-password-section')).not.toBeInTheDocument();
  });
});
