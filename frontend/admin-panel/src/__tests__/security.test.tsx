import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Security from '../pages/Security';

const mockAuditLogs = [
  {
    id: 'al-1',
    clientId: null,
    actionType: 'login.failed',
    resourceType: 'auth',
    resourceId: null,
    actorId: 'user-1',
    actorType: 'user' as const,
    httpMethod: 'POST',
    httpPath: '/api/v1/auth/login',
    httpStatus: 401,
    changes: null,
    ipAddress: '192.168.1.1',
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  },
  {
    id: 'al-2',
    clientId: 'client-1',
    actionType: 'certificate.renewed',
    resourceType: 'ssl-cert',
    resourceId: 'cert-1',
    actorId: 'system',
    actorType: 'system' as const,
    httpMethod: 'PUT',
    httpPath: '/api/v1/admin/ssl-certs/cert-1',
    httpStatus: 200,
    changes: null,
    ipAddress: null,
    createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
  },
  {
    id: 'al-3',
    clientId: null,
    actionType: 'request.server_error',
    resourceType: 'api-gateway',
    resourceId: null,
    actorId: 'user-2',
    actorType: 'user' as const,
    httpMethod: 'GET',
    httpPath: '/api/v1/admin/clients',
    httpStatus: 500,
    changes: null,
    ipAddress: '10.0.0.1',
    createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
  },
];

const mockUseAuditLogs = vi.fn();

vi.mock('@/hooks/use-audit-logs', () => ({
  useAuditLogs: (...args: unknown[]) => mockUseAuditLogs(...args),
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

describe('Security page', () => {
  beforeEach(() => {
    mockUseAuditLogs.mockReturnValue({
      data: { data: mockAuditLogs },
      isLoading: false,
      error: null,
    });
  });

  it('renders page heading "Security"', () => {
    render(<Security />, { wrapper: createWrapper() });
    expect(screen.getByRole('heading', { name: 'Security' })).toBeInTheDocument();
  });

  it('shows all four stat cards', () => {
    render(<Security />, { wrapper: createWrapper() });
    expect(screen.getAllByText('Network Policies').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Sealed Secrets')).toBeInTheDocument();
    expect(screen.getByText('SSL Certificates')).toBeInTheDocument();
    expect(screen.getByText('Security Score')).toBeInTheDocument();
    const statCards = screen.getAllByTestId('stat-card');
    expect(statCards).toHaveLength(4);
  });

  it('displays stat card values with dynamic policy count and dashes for unavailable metrics', () => {
    render(<Security />, { wrapper: createWrapper() });
    expect(screen.getByText('5')).toBeInTheDocument();
    const dashes = screen.getAllByText('\u2014');
    expect(dashes).toHaveLength(3);
  });

  it('renders the Network Policies section with table', () => {
    render(<Security />, { wrapper: createWrapper() });
    expect(screen.getByText('Network Policies', { selector: 'h2' })).toBeInTheDocument();
    expect(screen.getByTestId('policies-table')).toBeInTheDocument();
    expect(screen.getByText('deny-all-ingress')).toBeInTheDocument();
    expect(screen.getByText('allow-ingress-nginx')).toBeInTheDocument();
    expect(screen.getByText('allow-dns-egress')).toBeInTheDocument();
  });

  it('renders the Recent Security Events section with audit log data', () => {
    render(<Security />, { wrapper: createWrapper() });
    expect(screen.getByText('Recent Security Events')).toBeInTheDocument();
    expect(screen.getByTestId('events-table')).toBeInTheDocument();
    expect(screen.getByText('login.failed')).toBeInTheDocument();
    expect(screen.getByText('certificate.renewed')).toBeInTheDocument();
    expect(screen.getByText('request.server_error')).toBeInTheDocument();
  });

  it('shows StatusBadge for policy statuses', () => {
    render(<Security />, { wrapper: createWrapper() });
    const badges = screen.getAllByTestId('status-badge');
    expect(badges.length).toBeGreaterThanOrEqual(5);
  });

  it('maps severity correctly based on httpStatus', () => {
    render(<Security />, { wrapper: createWrapper() });
    // 401 -> error severity, label "error"
    expect(screen.getAllByText('error').length).toBeGreaterThanOrEqual(1);
    // 500 -> error severity, label "critical"
    expect(screen.getByText('critical')).toBeInTheDocument();
    // 200 -> active severity, label "info"
    expect(screen.getAllByText('info').length).toBeGreaterThanOrEqual(1);
  });

  it('shows event sources from resourceType', () => {
    render(<Security />, { wrapper: createWrapper() });
    expect(screen.getByText('auth')).toBeInTheDocument();
    expect(screen.getByText('ssl-cert')).toBeInTheDocument();
    expect(screen.getByText('api-gateway')).toBeInTheDocument();
  });

  it('shows loading state when audit logs are loading', () => {
    mockUseAuditLogs.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });
    render(<Security />, { wrapper: createWrapper() });
    expect(screen.getByText('Loading security events...')).toBeInTheDocument();
  });

  it('shows error state when audit logs fail to load', () => {
    mockUseAuditLogs.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('Network error'),
    });
    render(<Security />, { wrapper: createWrapper() });
    expect(screen.getByText('Failed to load security events. Please try again later.')).toBeInTheDocument();
  });

  it('shows empty state when no audit logs exist', () => {
    mockUseAuditLogs.mockReturnValue({
      data: { data: [] },
      isLoading: false,
      error: null,
    });
    render(<Security />, { wrapper: createWrapper() });
    expect(screen.getByText('No security events recorded yet.')).toBeInTheDocument();
  });

  it('displays the default configuration banner', () => {
    render(<Security />, { wrapper: createWrapper() });
    expect(screen.getByText(/Network policies below are the platform's default configuration/)).toBeInTheDocument();
  });

  it('calls useAuditLogs with limit of 10', () => {
    render(<Security />, { wrapper: createWrapper() });
    expect(mockUseAuditLogs).toHaveBeenCalledWith(10);
  });
});
