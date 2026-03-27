import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, beforeEach } from 'vitest';
import Login from '../pages/Login';
import { useAuth } from '../hooks/use-auth';

function renderWithProviders(ui: React.ReactElement, route = '/login') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Login page', () => {
  it('renders login form', () => {
    renderWithProviders(<Login />);
    expect(screen.getByTestId('email-input')).toBeInTheDocument();
    expect(screen.getByTestId('password-input')).toBeInTheDocument();
    expect(screen.getByTestId('login-button')).toBeInTheDocument();
  });

  it('shows platform name', () => {
    renderWithProviders(<Login />);
    expect(screen.getByText('K8s Hosting Platform')).toBeInTheDocument();
    expect(screen.getByText('Sign in to admin panel')).toBeInTheDocument();
  });

  it('has required fields', () => {
    renderWithProviders(<Login />);
    expect(screen.getByTestId('email-input')).toBeRequired();
    expect(screen.getByTestId('password-input')).toBeRequired();
  });
});

describe('useAuth store', () => {
  beforeEach(() => {
    localStorage.clear();
    useAuth.setState({
      token: null,
      user: null,
      isAuthenticated: false,
      isLoading: true,
      error: null,
    });
  });

  it('initializes from localStorage', () => {
    localStorage.setItem('auth_token', 'test-token');
    localStorage.setItem(
      'auth_user',
      JSON.stringify({ id: '1', email: 'a@b.com', fullName: 'Test', role: 'admin' }),
    );

    useAuth.getState().initialize();
    const state = useAuth.getState();

    expect(state.isAuthenticated).toBe(true);
    expect(state.token).toBe('test-token');
    expect(state.user?.email).toBe('a@b.com');
    expect(state.isLoading).toBe(false);
  });

  it('initializes as unauthenticated when no token', () => {
    useAuth.getState().initialize();
    const state = useAuth.getState();

    expect(state.isAuthenticated).toBe(false);
    expect(state.token).toBeNull();
    expect(state.isLoading).toBe(false);
  });

  it('clears state on logout', () => {
    localStorage.setItem('auth_token', 'test-token');
    localStorage.setItem('auth_user', JSON.stringify({ id: '1' }));

    useAuth.getState().logout();
    const state = useAuth.getState();

    expect(state.isAuthenticated).toBe(false);
    expect(state.token).toBeNull();
    expect(localStorage.getItem('auth_token')).toBeNull();
    expect(localStorage.getItem('auth_user')).toBeNull();
  });
});
