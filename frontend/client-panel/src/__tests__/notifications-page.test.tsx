import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Notifications from '../pages/Notifications';

const mockNotifications = [
  {
    id: 'n-1',
    userId: 'u-1',
    type: 'info' as const,
    title: 'Welcome',
    message: 'Welcome to the platform',
    resourceType: null,
    resourceId: null,
    isRead: 0,
    readAt: null,
    createdAt: '2026-04-09T10:00:00.000Z',
  },
  {
    id: 'n-2',
    userId: 'u-1',
    type: 'warning' as const,
    title: 'Storage warning',
    message: 'You are using 85% of your storage quota',
    resourceType: 'storage',
    resourceId: 'volume-1',
    isRead: 0,
    readAt: null,
    createdAt: '2026-04-09T11:00:00.000Z',
  },
  {
    id: 'n-3',
    userId: 'u-1',
    type: 'success' as const,
    title: 'Backup complete',
    message: 'Your backup finished successfully',
    resourceType: 'backup',
    resourceId: 'backup-7',
    isRead: 1,
    readAt: '2026-04-09T11:30:00.000Z',
    createdAt: '2026-04-09T11:25:00.000Z',
  },
];

const markReadMutate = vi.fn();
const deleteMutate = vi.fn();

interface MockListHook {
  readonly data: { readonly data: readonly typeof mockNotifications[number][] };
  readonly isLoading: boolean;
  readonly isError: boolean;
}
interface MockMutHook {
  readonly mutate: typeof markReadMutate;
  readonly isPending: boolean;
}

const listHook = vi.fn<() => MockListHook>(() => ({
  data: { data: mockNotifications },
  isLoading: false,
  isError: false,
}));
const markReadHook = vi.fn<() => MockMutHook>(() => ({
  mutate: markReadMutate,
  isPending: false,
}));
const deleteHook = vi.fn<() => MockMutHook>(() => ({
  mutate: deleteMutate,
  isPending: false,
}));

vi.mock('../hooks/use-notifications', () => ({
  useNotifications: () => listHook(),
  useMarkNotificationsRead: () => markReadHook(),
  useDeleteNotification: () => deleteHook(),
}));

function createWrapper() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('Notifications page', () => {
  beforeEach(() => {
    listHook.mockReturnValue({
      data: { data: mockNotifications },
      isLoading: false,
      isError: false,
    });
    markReadHook.mockReturnValue({ mutate: markReadMutate, isPending: false });
    deleteHook.mockReturnValue({ mutate: deleteMutate, isPending: false });
    markReadMutate.mockReset();
    deleteMutate.mockReset();
  });

  it('renders the heading and counts', () => {
    render(<Notifications />, { wrapper: createWrapper() });
    expect(screen.getByTestId('notifications-heading')).toBeInTheDocument();
    expect(screen.getByTestId('notifications-count')).toHaveTextContent('3 shown');
    expect(screen.getByTestId('notifications-count')).toHaveTextContent('2 unread');
  });

  it('renders all notification rows', () => {
    render(<Notifications />, { wrapper: createWrapper() });
    expect(screen.getByTestId('notification-n-1')).toBeInTheDocument();
    expect(screen.getByTestId('notification-n-2')).toBeInTheDocument();
    expect(screen.getByTestId('notification-n-3')).toBeInTheDocument();
    expect(screen.getByText('Welcome')).toBeInTheDocument();
    expect(screen.getByText('Storage warning')).toBeInTheDocument();
    expect(screen.getByText('Backup complete')).toBeInTheDocument();
  });

  it('filters by type', async () => {
    const user = userEvent.setup();
    render(<Notifications />, { wrapper: createWrapper() });
    await user.selectOptions(screen.getByTestId('filter-type'), 'warning');
    expect(screen.getByTestId('notifications-count')).toHaveTextContent('1 shown');
    expect(screen.getByTestId('notification-n-2')).toBeInTheDocument();
    expect(screen.queryByTestId('notification-n-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('notification-n-3')).not.toBeInTheDocument();
  });

  it('filters by read state', async () => {
    const user = userEvent.setup();
    render(<Notifications />, { wrapper: createWrapper() });
    await user.selectOptions(screen.getByTestId('filter-read'), 'unread');
    expect(screen.getByTestId('notifications-count')).toHaveTextContent('2 shown');
    expect(screen.queryByTestId('notification-n-3')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByTestId('filter-read'), 'read');
    expect(screen.getByTestId('notifications-count')).toHaveTextContent('1 shown');
    expect(screen.getByTestId('notification-n-3')).toBeInTheDocument();
    expect(screen.queryByTestId('notification-n-1')).not.toBeInTheDocument();
  });

  it('marks an individual notification as read', async () => {
    const user = userEvent.setup();
    render(<Notifications />, { wrapper: createWrapper() });
    await user.click(screen.getByTestId('mark-read-n-1'));
    expect(markReadMutate).toHaveBeenCalledWith(['n-1']);
  });

  it('does not show mark-read button on already-read items', () => {
    render(<Notifications />, { wrapper: createWrapper() });
    const readRow = screen.getByTestId('notification-n-3');
    expect(within(readRow).queryByTestId('mark-read-n-3')).not.toBeInTheDocument();
  });

  it('marks all visible unread as read', async () => {
    const user = userEvent.setup();
    render(<Notifications />, { wrapper: createWrapper() });
    await user.click(screen.getByTestId('mark-all-read-button'));
    expect(markReadMutate).toHaveBeenCalledWith(['n-1', 'n-2']);
  });

  it('requires confirmation before deleting a notification', async () => {
    const user = userEvent.setup();
    render(<Notifications />, { wrapper: createWrapper() });
    await user.click(screen.getByTestId('delete-notification-n-2'));
    // First click reveals confirm/cancel — does NOT fire mutate
    expect(deleteMutate).not.toHaveBeenCalled();
    expect(screen.getByTestId('confirm-delete-n-2')).toBeInTheDocument();
    await user.click(screen.getByTestId('confirm-delete-confirm-n-2'));
    expect(deleteMutate).toHaveBeenCalledWith('n-2');
  });

  it('cancels delete confirmation without firing the mutation', async () => {
    const user = userEvent.setup();
    render(<Notifications />, { wrapper: createWrapper() });
    await user.click(screen.getByTestId('delete-notification-n-1'));
    expect(screen.getByTestId('confirm-delete-n-1')).toBeInTheDocument();
    await user.click(screen.getByTestId('confirm-delete-cancel-n-1'));
    expect(deleteMutate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('confirm-delete-n-1')).not.toBeInTheDocument();
  });

  it('shows the empty state when there are no notifications', () => {
    listHook.mockReturnValue({
      data: { data: [] },
      isLoading: false,
      isError: false,
    });
    render(<Notifications />, { wrapper: createWrapper() });
    expect(screen.getByTestId('notifications-empty')).toBeInTheDocument();
    expect(screen.getByText(/No notifications yet/)).toBeInTheDocument();
  });

  it('shows a filter-specific empty message when filters hide everything', async () => {
    const user = userEvent.setup();
    render(<Notifications />, { wrapper: createWrapper() });
    await user.selectOptions(screen.getByTestId('filter-type'), 'error');
    expect(screen.getByTestId('notifications-empty')).toBeInTheDocument();
    expect(screen.getByText(/No notifications match/)).toBeInTheDocument();
  });

  it('shows the loading state', () => {
    listHook.mockReturnValue({
      data: undefined as unknown as { data: readonly typeof mockNotifications[number][] },
      isLoading: true,
      isError: false,
    });
    render(<Notifications />, { wrapper: createWrapper() });
    expect(screen.queryByTestId('notifications-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('notifications-empty')).not.toBeInTheDocument();
  });

  it('shows the error state', () => {
    listHook.mockReturnValue({
      data: undefined as unknown as { data: readonly typeof mockNotifications[number][] },
      isLoading: false,
      isError: true,
    });
    render(<Notifications />, { wrapper: createWrapper() });
    expect(screen.getByText(/Failed to load notifications/)).toBeInTheDocument();
  });
});
