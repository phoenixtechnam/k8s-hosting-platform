import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import NotificationDropdown from '../components/NotificationDropdown';

const mockNotifications = [
  { id: '1', userId: 'u1', type: 'info' as const, title: 'Client Created', message: 'New client Acme Corp', resourceType: 'client', resourceId: 'c1', isRead: 0, readAt: null, createdAt: new Date().toISOString() },
  { id: '2', userId: 'u1', type: 'warning' as const, title: 'Domain Update', message: 'Domain example.com updated', resourceType: 'domain', resourceId: 'd1', isRead: 0, readAt: null, createdAt: new Date(Date.now() - 3_600_000).toISOString() },
];

vi.mock('../hooks/use-notifications', () => ({
  useNotifications: vi.fn(() => ({
    data: { data: mockNotifications },
    isLoading: false,
    isError: false,
  })),
  useUnreadCount: vi.fn(() => ({
    data: { data: { count: 2 } },
  })),
  useMarkNotificationsRead: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
  useDeleteNotification: vi.fn(() => ({
    mutate: vi.fn(),
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

describe('Admin NotificationDropdown', () => {
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

  it('displays notification items with title and message', async () => {
    const user = userEvent.setup();
    render(<NotificationDropdown />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('notification-bell'));

    expect(screen.getByText('Client Created')).toBeInTheDocument();
    expect(screen.getByText('Domain Update')).toBeInTheDocument();
  });

  it('shows relative time for notifications', async () => {
    const user = userEvent.setup();
    render(<NotificationDropdown />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('notification-bell'));

    expect(screen.getByText('just now')).toBeInTheDocument();
  });

  it('shows View all activity link', async () => {
    const user = userEvent.setup();
    render(<NotificationDropdown />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('notification-bell'));

    expect(screen.getByTestId('notification-view-all')).toBeInTheDocument();
    expect(screen.getByText('View all activity')).toBeInTheDocument();
  });

  it('closes dropdown when bell is clicked again', async () => {
    const user = userEvent.setup();
    render(<NotificationDropdown />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('notification-bell'));
    expect(screen.getByTestId('notification-dropdown')).toBeInTheDocument();

    await user.click(screen.getByTestId('notification-bell'));
    expect(screen.queryByTestId('notification-dropdown')).not.toBeInTheDocument();
  });

  it('shows unread count badge', () => {
    render(<NotificationDropdown />, { wrapper: createWrapper() });
    expect(screen.getByText('2')).toBeInTheDocument();
  });
});
