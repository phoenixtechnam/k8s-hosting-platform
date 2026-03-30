import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Login from '../pages/Login';

vi.mock('../hooks/use-auth', () => ({
  useAuth: vi.fn(() => ({
    user: null,
    token: null,
    isAuthenticated: false,
    isLoading: false,
    error: null,
    login: vi.fn(),
    logout: vi.fn(),
    initialize: vi.fn(),
    setTokenAndUser: vi.fn(),
  })),
}));

vi.mock('../lib/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve({ data: { localAuthEnabled: true, providers: [] } })),
}));

import { useAuth } from '../hooks/use-auth';
import { apiFetch } from '../lib/api-client';

const mockedUseAuth = vi.mocked(useAuth);
const mockedApiFetch = vi.mocked(apiFetch);

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Login Page', () => {
  it('renders the Client Portal heading', () => {
    renderWithProviders(<Login />);
    expect(screen.getByText('Client Portal')).toBeInTheDocument();
  });

  it('renders sign-in description', () => {
    renderWithProviders(<Login />);
    expect(screen.getByText('Sign in to manage your hosting')).toBeInTheDocument();
  });

  it('renders login form with email and password inputs', () => {
    renderWithProviders(<Login />);
    expect(screen.getByTestId('login-form')).toBeInTheDocument();
    expect(screen.getByTestId('email-input')).toBeInTheDocument();
    expect(screen.getByTestId('password-input')).toBeInTheDocument();
  });

  it('renders the Sign In button', () => {
    renderWithProviders(<Login />);
    expect(screen.getByTestId('login-button')).toBeInTheDocument();
    expect(screen.getByText('Sign In')).toBeInTheDocument();
  });

  it('shows error message when auth error exists', () => {
    mockedUseAuth.mockReturnValue({
      user: null,
      token: null,
      isAuthenticated: false,
      isLoading: false,
      error: 'Invalid credentials',
      login: vi.fn(),
      logout: vi.fn(),
      initialize: vi.fn(),
      setTokenAndUser: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);

    renderWithProviders(<Login />);
    expect(screen.getByTestId('login-error')).toBeInTheDocument();
    expect(screen.getByText('Invalid credentials')).toBeInTheDocument();
  });

  it('renders SSO buttons when providers are available', async () => {
    mockedApiFetch.mockResolvedValue({
      data: {
        localAuthEnabled: true,
        providers: [{ id: 'dex', displayName: 'Company SSO' }],
      },
    });

    renderWithProviders(<Login />);

    const ssoButton = await screen.findByTestId('sso-button-dex');
    expect(ssoButton).toBeInTheDocument();
    expect(screen.getByText('Sign in with Company SSO')).toBeInTheDocument();
  });
});
