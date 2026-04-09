import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import NotificationDropdown from '../components/NotificationDropdown';

vi.mock('../hooks/use-notifications', () => ({
  useNotifications: vi.fn(() => ({
    data: { data: [] },
    isLoading: false,
    isError: false,
  })),
  useUnreadCount: vi.fn(() => ({
    data: { data: { count: 0 } },
    isLoading: false,
  })),
  useMarkNotificationsRead: vi.fn(() => ({ mutate: vi.fn() })),
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

describe('Client NotificationDropdown', () => {
  it('renders bell icon button', () => {
    render(<NotificationDropdown />, { wrapper: createWrapper() });
    expect(screen.getByTestId('notification-bell')).toBeInTheDocument();
  });

  it('opens dropdown when bell is clicked', async () => {
    const user = userEvent.setup();
    render(<NotificationDropdown />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('notification-bell'));

    expect(screen.getByTestId('notification-dropdown')).toBeInTheDocument();
  });

  it('shows Notifications heading in dropdown', async () => {
    const user = userEvent.setup();
    render(<NotificationDropdown />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('notification-bell'));

    expect(screen.getByText('Notifications')).toBeInTheDocument();
  });

  it('shows no new notifications message', async () => {
    const user = userEvent.setup();
    render(<NotificationDropdown />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('notification-bell'));

    expect(screen.getByText('No new notifications')).toBeInTheDocument();
  });

  it('closes dropdown when bell is clicked again', async () => {
    const user = userEvent.setup();
    render(<NotificationDropdown />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('notification-bell'));
    expect(screen.getByTestId('notification-dropdown')).toBeInTheDocument();

    await user.click(screen.getByTestId('notification-bell'));
    expect(screen.queryByTestId('notification-dropdown')).not.toBeInTheDocument();
  });

  it('does not show red badge when there are no unread notifications', () => {
    const { container } = render(<NotificationDropdown />, { wrapper: createWrapper() });
    const redDot = container.querySelector('.bg-red-500');
    expect(redDot).not.toBeInTheDocument();
  });

  it('renders the View all notifications footer link pointing at /notifications', async () => {
    const user = userEvent.setup();
    render(<NotificationDropdown />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('notification-bell'));

    const link = screen.getByTestId('notification-view-all');
    expect(link).toBeInTheDocument();
    expect(link).toHaveTextContent('View all notifications');
    expect(link).toHaveAttribute('href', '/notifications');
  });

  it('closes the dropdown when the View all link is clicked', async () => {
    const user = userEvent.setup();
    render(<NotificationDropdown />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('notification-bell'));
    expect(screen.getByTestId('notification-dropdown')).toBeInTheDocument();

    await user.click(screen.getByTestId('notification-view-all'));
    expect(screen.queryByTestId('notification-dropdown')).not.toBeInTheDocument();
  });
});
