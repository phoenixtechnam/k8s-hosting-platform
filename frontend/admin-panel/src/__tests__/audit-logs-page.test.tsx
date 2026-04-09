import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AuditLogs from '../pages/AuditLogs';

const useAuditLogsMock = vi.fn();

vi.mock('../hooks/use-audit-logs', () => ({
  useAuditLogs: (params: unknown) => useAuditLogsMock(params),
}));

const SEED_ENTRIES = [
  {
    id: 'a1',
    clientId: 'c1',
    actionType: 'create',
    resourceType: 'client',
    resourceId: 'c1',
    actorId: 'admin-1',
    actorType: 'user' as const,
    httpMethod: 'POST',
    httpPath: '/api/v1/clients',
    httpStatus: 201,
    changes: { companyName: 'Acme' },
    ipAddress: '10.0.0.1',
    createdAt: '2026-04-09T10:00:00.000Z',
  },
  {
    id: 'a2',
    clientId: 'c1',
    actionType: 'update',
    resourceType: 'user',
    resourceId: 'u1',
    actorId: 'admin-1',
    actorType: 'user' as const,
    httpMethod: 'PATCH',
    httpPath: '/api/v1/clients/c1/users/u1',
    httpStatus: 200,
    changes: { role_name: 'client_admin' },
    ipAddress: '10.0.0.1',
    createdAt: '2026-04-09T11:00:00.000Z',
  },
  {
    id: 'a3',
    clientId: null,
    actionType: 'delete',
    resourceType: 'admin_user',
    resourceId: 'au1',
    actorId: 'super-admin',
    actorType: 'user' as const,
    httpMethod: 'DELETE',
    httpPath: '/api/v1/admin/users/au1',
    httpStatus: 204,
    changes: null,
    ipAddress: '10.0.0.1',
    createdAt: '2026-04-09T12:00:00.000Z',
  },
];

function wrap(children: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('AuditLogs page', () => {
  beforeEach(() => {
    useAuditLogsMock.mockReset();
    useAuditLogsMock.mockReturnValue({
      data: {
        data: SEED_ENTRIES,
        pagination: { cursor: null, has_more: false, page_size: 3, total_count: 3 },
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      error: null,
    });
  });

  it('renders the heading and description', () => {
    render(wrap(<AuditLogs />));
    expect(screen.getByTestId('audit-logs-heading')).toBeInTheDocument();
    expect(screen.getByText(/All mutating requests across the platform/)).toBeInTheDocument();
  });

  it('renders the filter bar with all controls', () => {
    render(wrap(<AuditLogs />));
    expect(screen.getByTestId('audit-logs-filters')).toBeInTheDocument();
    expect(screen.getByTestId('filter-action-type')).toBeInTheDocument();
    expect(screen.getByTestId('filter-resource-type')).toBeInTheDocument();
    expect(screen.getByTestId('filter-http-method')).toBeInTheDocument();
    expect(screen.getByTestId('filter-search')).toBeInTheDocument();
    expect(screen.getByTestId('filter-from')).toBeInTheDocument();
    expect(screen.getByTestId('filter-to')).toBeInTheDocument();
    expect(screen.getByTestId('filter-client-id')).toBeInTheDocument();
    expect(screen.getByTestId('filter-actor-id')).toBeInTheDocument();
  });

  it('renders the audit log table with all seed rows', () => {
    render(wrap(<AuditLogs />));
    expect(screen.getByTestId('audit-logs-table')).toBeInTheDocument();
    expect(screen.getByTestId('audit-log-row-a1')).toBeInTheDocument();
    expect(screen.getByTestId('audit-log-row-a2')).toBeInTheDocument();
    expect(screen.getByTestId('audit-log-row-a3')).toBeInTheDocument();
  });

  it('shows the action-type badge text for each row', () => {
    render(wrap(<AuditLogs />));
    expect(screen.getByText('create')).toBeInTheDocument();
    expect(screen.getByText('update')).toBeInTheDocument();
    expect(screen.getByText('delete')).toBeInTheDocument();
  });

  it('shows the count badge with total_count', () => {
    render(wrap(<AuditLogs />));
    expect(screen.getByTestId('audit-logs-count')).toHaveTextContent('3 shown of 3');
  });

  it('expands a row to show details and the changes JSON', async () => {
    const user = userEvent.setup();
    render(wrap(<AuditLogs />));
    await user.click(screen.getByTestId('audit-log-row-a1'));
    expect(screen.getByTestId('audit-log-details-a1')).toBeInTheDocument();
    expect(screen.getByText(/"companyName"/)).toBeInTheDocument();
    expect(screen.getByText(/"Acme"/)).toBeInTheDocument();
  });

  it('collapses an expanded row when clicked again', async () => {
    const user = userEvent.setup();
    render(wrap(<AuditLogs />));
    await user.click(screen.getByTestId('audit-log-row-a1'));
    expect(screen.getByTestId('audit-log-details-a1')).toBeInTheDocument();
    await user.click(screen.getByTestId('audit-log-row-a1'));
    expect(screen.queryByTestId('audit-log-details-a1')).not.toBeInTheDocument();
  });

  it('applies the action-type filter through the hook', async () => {
    const user = userEvent.setup();
    render(wrap(<AuditLogs />));
    await user.selectOptions(screen.getByTestId('filter-action-type'), 'create');
    // Last call should include action_type: 'create'
    const lastCall = useAuditLogsMock.mock.calls.at(-1)?.[0];
    expect(lastCall).toMatchObject({ action_type: 'create' });
  });

  it('applies the http_method filter', async () => {
    const user = userEvent.setup();
    render(wrap(<AuditLogs />));
    await user.selectOptions(screen.getByTestId('filter-http-method'), 'DELETE');
    const lastCall = useAuditLogsMock.mock.calls.at(-1)?.[0];
    expect(lastCall).toMatchObject({ http_method: 'DELETE' });
  });

  it('applies the search filter', async () => {
    const user = userEvent.setup();
    render(wrap(<AuditLogs />));
    await user.type(screen.getByTestId('filter-search'), '/clients');
    const lastCall = useAuditLogsMock.mock.calls.at(-1)?.[0];
    expect(lastCall).toMatchObject({ search: '/clients' });
  });

  it('shows and hides the Clear filters button based on active filters', async () => {
    const user = userEvent.setup();
    render(wrap(<AuditLogs />));
    expect(screen.queryByTestId('clear-filters')).not.toBeInTheDocument();
    await user.selectOptions(screen.getByTestId('filter-action-type'), 'create');
    expect(screen.getByTestId('clear-filters')).toBeInTheDocument();
    await user.click(screen.getByTestId('clear-filters'));
    expect(screen.queryByTestId('clear-filters')).not.toBeInTheDocument();
  });

  it('shows the empty state when there are zero entries', () => {
    useAuditLogsMock.mockReturnValue({
      data: {
        data: [],
        pagination: { cursor: null, has_more: false, page_size: 0, total_count: 0 },
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      error: null,
    });
    render(wrap(<AuditLogs />));
    expect(screen.getByTestId('audit-logs-empty')).toBeInTheDocument();
    expect(screen.getByText(/No audit log entries/)).toBeInTheDocument();
  });

  it('shows the loading state on first fetch', () => {
    useAuditLogsMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      isFetching: true,
      error: null,
    });
    render(wrap(<AuditLogs />));
    expect(screen.getByTestId('audit-logs-loading')).toBeInTheDocument();
  });

  it('shows the error state', () => {
    useAuditLogsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      isFetching: false,
      error: new Error('Network error'),
    });
    render(wrap(<AuditLogs />));
    expect(screen.getByTestId('audit-logs-error')).toBeInTheDocument();
    expect(screen.getByText(/Failed to load audit logs/)).toBeInTheDocument();
  });

  it('shows the Load more button when has_more is true', () => {
    useAuditLogsMock.mockReturnValue({
      data: {
        data: SEED_ENTRIES,
        pagination: { cursor: 'next-cursor', has_more: true, page_size: 3, total_count: 100 },
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      error: null,
    });
    render(wrap(<AuditLogs />));
    expect(screen.getByTestId('audit-logs-load-more')).toBeInTheDocument();
  });

  it('hides the Load more button when has_more is false', () => {
    render(wrap(<AuditLogs />));
    expect(screen.queryByTestId('audit-logs-load-more')).not.toBeInTheDocument();
  });
});
