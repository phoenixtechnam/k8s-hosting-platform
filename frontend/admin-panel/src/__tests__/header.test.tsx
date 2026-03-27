import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Header from '../components/layout/Header';

const mockLogout = vi.fn();

vi.mock('../hooks/use-auth', () => ({
  useAuth: vi.fn(() => ({
    user: { id: 'admin-1', email: 'admin@platform.local', fullName: 'Admin User', role: 'admin' },
    token: 'test-token',
    isAuthenticated: true,
    isLoading: false,
    error: null,
    login: vi.fn(),
    logout: mockLogout,
    initialize: vi.fn(),
  })),
}));

vi.mock('../hooks/use-password', () => ({
  useChangePassword: vi.fn(() => ({
    mutateAsync: vi.fn().mockResolvedValue({ data: { message: 'Password updated successfully' } }),
    isPending: false,
  })),
}));

vi.mock('../hooks/use-notifications', () => ({
  useNotifications: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
  useUnreadCount: vi.fn(() => ({ data: { data: { count: 0 } } })),
  useMarkNotificationsRead: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useDeleteNotification: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

vi.mock('../hooks/use-dark-mode', () => ({
  useDarkMode: vi.fn(() => ({ theme: 'system', isDark: false, setTheme: vi.fn(), cycle: vi.fn() })),
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

describe('Admin Header user menu', () => {
  it('renders user menu button', () => {
    render(<Header onMenuClick={vi.fn()} />, { wrapper: createWrapper() });
    expect(screen.getByTestId('user-menu-button')).toBeInTheDocument();
  });

  it('opens dropdown on click and shows user name and email', async () => {
    const user = userEvent.setup();
    render(<Header onMenuClick={vi.fn()} />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('user-menu-button'));

    expect(screen.getByTestId('user-menu-dropdown')).toBeInTheDocument();
    expect(screen.getByTestId('user-menu-name')).toHaveTextContent('Admin User');
    expect(screen.getByTestId('user-menu-email')).toHaveTextContent('admin@platform.local');
  });

  it('shows Change Password and Sign Out options', async () => {
    const user = userEvent.setup();
    render(<Header onMenuClick={vi.fn()} />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('user-menu-button'));

    expect(screen.getByTestId('change-password-menu-item')).toBeInTheDocument();
    expect(screen.getByTestId('user-menu-sign-out')).toBeInTheDocument();
  });

  it('calls logout when Sign Out is clicked', async () => {
    const user = userEvent.setup();
    render(<Header onMenuClick={vi.fn()} />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('user-menu-button'));
    await user.click(screen.getByTestId('user-menu-sign-out'));

    expect(mockLogout).toHaveBeenCalled();
  });

  it('shows password form when Change Password is clicked', async () => {
    const user = userEvent.setup();
    render(<Header onMenuClick={vi.fn()} />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('user-menu-button'));
    await user.click(screen.getByTestId('change-password-menu-item'));

    expect(screen.getByTestId('user-menu-password-form')).toBeInTheDocument();
    expect(screen.getByTestId('menu-current-password')).toBeInTheDocument();
    expect(screen.getByTestId('menu-new-password')).toBeInTheDocument();
    expect(screen.getByTestId('menu-confirm-password')).toBeInTheDocument();
  });

  it('closes dropdown when clicking user menu button again', async () => {
    const user = userEvent.setup();
    render(<Header onMenuClick={vi.fn()} />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('user-menu-button'));
    expect(screen.getByTestId('user-menu-dropdown')).toBeInTheDocument();

    await user.click(screen.getByTestId('user-menu-button'));
    expect(screen.queryByTestId('user-menu-dropdown')).not.toBeInTheDocument();
  });
});
