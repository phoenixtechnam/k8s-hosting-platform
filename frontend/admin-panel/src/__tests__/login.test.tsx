import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Login from '../pages/Login';
import { apiFetch } from '@/lib/api-client';

vi.mock('@/lib/api-client', () => ({
  API_BASE: 'http://localhost:3000',
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

const mockApiFetch = vi.mocked(apiFetch);

function createWrapper(initialEntries: string[] = ['/login']) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: local auth enabled, no OIDC providers
  mockApiFetch.mockResolvedValue({ data: { localAuthEnabled: true, providers: [] } });
});

describe('Login page', () => {
  it('renders platform title', () => {
    render(<Login />, { wrapper: createWrapper() });
    expect(screen.getByText('K8s Hosting Platform')).toBeInTheDocument();
  });

  it('shows sign in subtitle', () => {
    render(<Login />, { wrapper: createWrapper() });
    expect(screen.getByText('Sign in to admin panel')).toBeInTheDocument();
  });

  it('renders email and password fields', () => {
    render(<Login />, { wrapper: createWrapper() });
    expect(screen.getByTestId('email-input')).toBeInTheDocument();
    expect(screen.getByTestId('password-input')).toBeInTheDocument();
  });

  it('renders sign in button', () => {
    render(<Login />, { wrapper: createWrapper() });
    expect(screen.getByTestId('login-button')).toBeInTheDocument();
    expect(screen.getByText('Sign In')).toBeInTheDocument();
  });

  it('renders login form', () => {
    render(<Login />, { wrapper: createWrapper() });
    expect(screen.getByTestId('login-form')).toBeInTheDocument();
  });

  it('shows emergency login form when emergency=true query param', () => {
    render(<Login />, { wrapper: createWrapper(['/login?emergency=true']) });
    expect(screen.getByText('Emergency Admin Login')).toBeInTheDocument();
    expect(screen.getByTestId('break-glass-form')).toBeInTheDocument();
    expect(screen.getByTestId('break-glass-secret-input')).toBeInTheDocument();
    expect(screen.getByTestId('break-glass-button')).toBeInTheDocument();
  });
});
