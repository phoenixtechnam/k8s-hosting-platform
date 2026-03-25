import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import Monitoring from '../pages/Monitoring';

const MOCK_AUDIT_ENTRIES = [
  {
    id: 'log-1',
    clientId: null,
    actionType: 'create',
    resourceType: 'client',
    resourceId: 'c-1',
    actorId: 'admin-1',
    actorType: 'user',
    httpMethod: 'POST',
    httpPath: '/api/v1/clients',
    httpStatus: 201,
    changes: null,
    ipAddress: '127.0.0.1',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'log-2',
    clientId: 'c-1',
    actionType: 'update',
    resourceType: 'domain',
    resourceId: 'd-1',
    actorId: 'admin-1',
    actorType: 'user',
    httpMethod: 'PATCH',
    httpPath: '/api/v1/clients/c-1/domains/d-1',
    httpStatus: 500,
    changes: null,
    ipAddress: '127.0.0.1',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'log-3',
    clientId: null,
    actionType: 'delete',
    resourceType: 'backup',
    resourceId: 'b-1',
    actorId: 'admin-1',
    actorType: 'user',
    httpMethod: 'DELETE',
    httpPath: '/api/v1/backups/b-1',
    httpStatus: 404,
    changes: null,
    ipAddress: '127.0.0.1',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'log-old-1',
    clientId: null,
    actionType: 'create',
    resourceType: 'region',
    resourceId: 'r-1',
    actorId: 'admin-1',
    actorType: 'user',
    httpMethod: 'POST',
    httpPath: '/api/v1/regions',
    httpStatus: 201,
    changes: null,
    ipAddress: '127.0.0.1',
    createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), // 2 days ago
  },
];

vi.mock('@/hooks/use-dashboard', () => ({
  usePlatformStatus: () => ({
    data: { data: { status: 'healthy', timestamp: '2026-03-25T00:00:00Z', version: '1.0.0' } },
  }),
}));

vi.mock('@/hooks/use-audit-logs', () => ({
  useAuditLogs: () => ({
    data: { data: MOCK_AUDIT_ENTRIES },
    isLoading: false,
    error: null,
  }),
}));

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

  it('shows Active Alerts count from audit log data', () => {
    render(<Monitoring />, { wrapper: createWrapper() });
    // 3 recent entries (within 24h), 1 old entry
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('renders Active Alerts tab by default with audit log data', () => {
    render(<Monitoring />, { wrapper: createWrapper() });
    expect(screen.getByTestId('tab-active-alerts')).toHaveClass('border-brand-500');
    expect(screen.getByText('create client')).toBeInTheDocument();
    expect(screen.getByText('update domain')).toBeInTheDocument();
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
    expect(screen.getByText('create region')).toBeInTheDocument();
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

  it('displays alert severity badges derived from httpStatus', () => {
    render(<Monitoring />, { wrapper: createWrapper() });
    // httpStatus 201 -> info, 500 -> critical, 404 -> warning
    expect(screen.getByText('critical')).toBeInTheDocument();
    expect(screen.getByText('warning')).toBeInTheDocument();
    expect(screen.getByText('info')).toBeInTheDocument();
  });
});
