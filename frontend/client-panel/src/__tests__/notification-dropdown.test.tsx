import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import NotificationDropdown from '../components/NotificationDropdown';

vi.mock('../hooks/use-notifications', () => ({
  useNotifications: vi.fn(() => ({
    data: [],
    isLoading: false,
    isError: false,
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

  it('does not show red dot when there are no notifications', () => {
    const { container } = render(<NotificationDropdown />, { wrapper: createWrapper() });
    const redDot = container.querySelector('.bg-red-500');
    expect(redDot).not.toBeInTheDocument();
  });
});
