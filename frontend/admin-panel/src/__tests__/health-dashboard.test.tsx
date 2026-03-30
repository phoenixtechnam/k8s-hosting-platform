import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import HealthDashboard from '../pages/HealthDashboard';
import { apiFetch } from '@/lib/api-client';

vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

const mockApiFetch = vi.mocked(apiFetch);

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('HealthDashboard page', () => {
  it('renders page heading', async () => {
    mockApiFetch.mockResolvedValue({
      data: { overall: 'healthy', services: [], checkedAt: '2026-01-01T00:00:00Z' },
    });
    render(<HealthDashboard />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('health-heading')).toBeInTheDocument();
    });
    expect(screen.getByText('System Health')).toBeInTheDocument();
  });

  it('shows loading state while fetching', () => {
    mockApiFetch.mockReturnValue(new Promise(() => {}));
    render(<HealthDashboard />, { wrapper: createWrapper() });
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeInTheDocument();
  });

  it('shows refresh button', async () => {
    mockApiFetch.mockResolvedValue({
      data: { overall: 'healthy', services: [], checkedAt: '2026-01-01T00:00:00Z' },
    });
    render(<HealthDashboard />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('refresh-health')).toBeInTheDocument();
    });
    expect(screen.getByText('Refresh')).toBeInTheDocument();
  });

  it('shows overall healthy status', async () => {
    mockApiFetch.mockResolvedValue({
      data: { overall: 'healthy', services: [], checkedAt: '2026-01-01T00:00:00Z' },
    });
    render(<HealthDashboard />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('overall-status')).toBeInTheDocument();
    });
    expect(screen.getByText('All Systems Operational')).toBeInTheDocument();
  });

  it('shows service cards when services are returned', async () => {
    mockApiFetch.mockResolvedValue({
      data: {
        overall: 'healthy',
        services: [
          { name: 'database', status: 'ok', latencyMs: 5 },
          { name: 'redis', status: 'ok', latencyMs: 2 },
        ],
        checkedAt: '2026-01-01T00:00:00Z',
      },
    });
    render(<HealthDashboard />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('health-service-database')).toBeInTheDocument();
    });
    expect(screen.getByTestId('health-service-redis')).toBeInTheDocument();
    expect(screen.getByText('Latency: 5ms')).toBeInTheDocument();
    expect(screen.getByText('Latency: 2ms')).toBeInTheDocument();
  });

  it('shows degraded overall status', async () => {
    mockApiFetch.mockResolvedValue({
      data: {
        overall: 'degraded',
        services: [{ name: 'redis', status: 'error', latencyMs: 0, message: 'Connection refused' }],
        checkedAt: '2026-01-01T00:00:00Z',
      },
    });
    render(<HealthDashboard />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText('Some Systems Degraded')).toBeInTheDocument();
    });
  });
});
