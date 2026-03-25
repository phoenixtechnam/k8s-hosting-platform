import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import Monitoring from '../pages/Monitoring';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('Monitoring page', () => {
  it('renders the page heading', () => {
    render(<Monitoring />, { wrapper: createWrapper() });
    expect(screen.getByRole('heading', { name: 'Monitoring' })).toBeInTheDocument();
  });

  it('shows all four stat cards', () => {
    render(<Monitoring />, { wrapper: createWrapper() });
    expect(screen.getByText('Platform Status')).toBeInTheDocument();
    expect(screen.getAllByText('Active Alerts').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Avg Response Time')).toBeInTheDocument();
    expect(screen.getByText('Error Rate')).toBeInTheDocument();
  });

  it('displays stat card values', () => {
    render(<Monitoring />, { wrapper: createWrapper() });
    expect(screen.getByText('45ms')).toBeInTheDocument();
    expect(screen.getByText('0.2%')).toBeInTheDocument();
  });

  it('renders Active Alerts tab by default', () => {
    render(<Monitoring />, { wrapper: createWrapper() });
    expect(screen.getByTestId('tab-active-alerts')).toHaveClass('border-brand-500');
    expect(screen.getByText('Node memory usage exceeds 95%')).toBeInTheDocument();
  });

  it('renders all three tab buttons', () => {
    render(<Monitoring />, { wrapper: createWrapper() });
    expect(screen.getByTestId('tab-active-alerts')).toBeInTheDocument();
    expect(screen.getByTestId('tab-alert-history')).toBeInTheDocument();
    expect(screen.getByTestId('tab-system-metrics')).toBeInTheDocument();
  });

  it('switches to Alert History tab on click', async () => {
    const user = userEvent.setup();
    render(<Monitoring />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('tab-alert-history'));

    expect(screen.getByTestId('tab-alert-history')).toHaveClass('border-brand-500');
    expect(screen.getByText('Database connection pool exhausted')).toBeInTheDocument();
    expect(screen.queryByText('Node memory usage exceeds 95%')).not.toBeInTheDocument();
  });

  it('shows Resolved badges in Alert History tab', async () => {
    const user = userEvent.setup();
    render(<Monitoring />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('tab-alert-history'));

    const resolvedBadges = screen.getAllByText('Resolved');
    expect(resolvedBadges.length).toBeGreaterThan(0);
  });

  it('switches to System Metrics tab and shows resource bars', async () => {
    const user = userEvent.setup();
    render(<Monitoring />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('tab-system-metrics'));

    expect(screen.getByTestId('system-metrics')).toBeInTheDocument();
    expect(screen.getByText('CPU Usage')).toBeInTheDocument();
    expect(screen.getByText('Memory Usage')).toBeInTheDocument();
    expect(screen.getByText('Disk Usage')).toBeInTheDocument();
    expect(screen.getByText('Network I/O')).toBeInTheDocument();
  });

  it('displays alert severity badges in the active alerts table', () => {
    render(<Monitoring />, { wrapper: createWrapper() });
    expect(screen.getByText('critical')).toBeInTheDocument();
    expect(screen.getAllByText('warning').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('info')).toBeInTheDocument();
  });
});
