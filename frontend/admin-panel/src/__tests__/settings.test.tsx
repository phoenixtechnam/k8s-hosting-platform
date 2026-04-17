import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Settings from '../pages/Settings';

vi.mock('../hooks/use-auth', () => ({
  useAuth: vi.fn(() => ({
    user: { id: 'admin-1', email: 'admin@k8s-platform.local-dev', fullName: 'Admin User', role: 'admin' },
    token: 'test-token', isAuthenticated: true, isLoading: false, error: null,
    login: vi.fn(), logout: vi.fn(), initialize: vi.fn(),
  })),
}));

vi.mock('../hooks/use-dashboard', () => ({
  usePlatformStatus: vi.fn(() => ({
    data: { data: { status: 'healthy', version: '0.1.0', timestamp: '2026-03-27T00:00:00Z' } },
    isLoading: false,
  })),
}));

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>;
  };
}

describe('Admin Settings page', () => {
  it('renders heading "Platform Settings"', () => {
    render(<Settings />, { wrapper: createWrapper() });
    expect(screen.getByTestId('settings-heading')).toBeInTheDocument();
    expect(screen.getByText('Platform Settings')).toBeInTheDocument();
  });

  it('shows Platform Status section with API data', () => {
    render(<Settings />, { wrapper: createWrapper() });
    expect(screen.getByTestId('platform-config-section')).toBeInTheDocument();
    expect(screen.getByText('Platform Status')).toBeInTheDocument();
    expect(screen.getByText('K8s Hosting Platform')).toBeInTheDocument();
    expect(screen.getByText('0.1.0')).toBeInTheDocument();
    expect(screen.getByText('healthy')).toBeInTheDocument();
  });

  it('shows links to OIDC, DNS, and Plan settings', () => {
    render(<Settings />, { wrapper: createWrapper() });
    expect(screen.getByTestId('oidc-settings-link')).toBeInTheDocument();
    expect(screen.getByTestId('dns-settings-link')).toBeInTheDocument();
    expect(screen.getByTestId('plan-settings-link')).toBeInTheDocument();
  });

  it('does not show Profile section (moved to user menu)', () => {
    render(<Settings />, { wrapper: createWrapper() });
    expect(screen.queryByTestId('profile-section')).not.toBeInTheDocument();
  });

  it('does not show Change Password section (moved to user menu)', () => {
    render(<Settings />, { wrapper: createWrapper() });
    expect(screen.queryByTestId('change-password-section')).not.toBeInTheDocument();
  });

  it('does not show Catalog Repositories section (moved to Workloads page)', () => {
    render(<Settings />, { wrapper: createWrapper() });
    expect(screen.queryByTestId('catalog-repos-section')).not.toBeInTheDocument();
  });
});
