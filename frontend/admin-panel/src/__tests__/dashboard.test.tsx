import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Dashboard from '../pages/Dashboard';

vi.mock('@/hooks/use-clients', () => ({
  useClients: () => ({
    data: { data: [], pagination: { total_count: 0 } },
    isLoading: false,
    error: null,
  }),
}));

vi.mock('@/hooks/use-dashboard', () => ({
  usePlatformStatus: () => ({
    data: { data: { status: 'healthy', timestamp: '2026-03-25T00:00:00Z', version: '1.0.0' } },
  }),
  useDashboardMetrics: () => ({
    data: {
      data: {
        total_clients: 12,
        active_clients: 10,
        total_domains: 25,
        total_backups: 3,
        platform_version: '1.0.0',
      },
    },
    isLoading: false,
  }),
}));

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Dashboard', () => {
  it('renders the Dashboard heading', () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
  });

  it('renders metric stat cards with values from the API', () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByText('Total Clients')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('10 active')).toBeInTheDocument();
    expect(screen.getByText('Domains')).toBeInTheDocument();
    expect(screen.getByText('25')).toBeInTheDocument();
    expect(screen.getByText('Backups')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('renders the platform status card', () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByText('Platform')).toBeInTheDocument();
    expect(screen.getByText('healthy')).toBeInTheDocument();
  });
});
