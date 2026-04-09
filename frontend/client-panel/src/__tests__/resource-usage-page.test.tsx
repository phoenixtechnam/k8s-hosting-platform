import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import ResourceUsage from '../pages/ResourceUsage';

vi.mock('../hooks/use-client-context', () => ({
  useClientContext: vi.fn(() => ({
    clientId: 'client-1',
    clientName: 'Test Company',
    isLoading: false,
  })),
}));

vi.mock('../hooks/use-resource-metrics', () => ({
  useResourceMetrics: vi.fn(() => ({
    data: {
      data: {
        clientId: 'client-1',
        cpu: { inUse: 0.5, reserved: 1.0, available: 2.0 },
        memory: { inUse: 1.2, reserved: 2.0, available: 4.0 },
        storage: { inUse: 8.0, reserved: 10.0, available: 20.0 },
        lastUpdatedAt: '2026-04-09T12:00:00.000Z',
      },
    },
    isLoading: false,
  })),
  useRefreshMetrics: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

vi.mock('../hooks/use-email', () => ({
  useMailboxUsage: vi.fn(() => ({
    data: {
      data: { current: 7, limit: 50, remaining: 43, source: 'plan' as const },
    },
    isLoading: false,
  })),
}));

vi.mock('../hooks/use-subscription', () => ({
  useSubscription: vi.fn(() => ({
    data: {
      data: {
        client_id: 'client-1',
        status: 'active',
        subscription_expires_at: null,
        created_at: '2026-01-01T00:00:00.000Z',
        plan: {
          id: 'plan-1',
          code: 'starter',
          name: 'Starter',
          description: null,
          cpuLimit: '2.00',
          memoryLimit: '4.00',
          storageLimit: '20.00',
          monthlyPriceUsd: '10.00',
          maxSubUsers: 3,
          maxMailboxes: 50,
          status: 'active',
        },
      },
    },
    isLoading: false,
  })),
}));

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('ResourceUsage page', () => {
  it('renders the heading and plan name', () => {
    render(<ResourceUsage />, { wrapper: createWrapper() });
    expect(screen.getByTestId('resource-usage-heading')).toBeInTheDocument();
    expect(screen.getByText(/Limits from your/)).toBeInTheDocument();
    expect(screen.getByText('Starter')).toBeInTheDocument();
  });

  it('renders CPU, Memory, Storage, and Mail cards', () => {
    render(<ResourceUsage />, { wrapper: createWrapper() });
    expect(screen.getByTestId('cpu-card')).toBeInTheDocument();
    expect(screen.getByTestId('memory-card')).toBeInTheDocument();
    expect(screen.getByTestId('storage-card')).toBeInTheDocument();
    expect(screen.getByTestId('mailbox-card')).toBeInTheDocument();
  });

  it('shows the CPU percent computed from inUse / available', () => {
    render(<ResourceUsage />, { wrapper: createWrapper() });
    // 0.5 / 2.0 = 25%
    expect(screen.getByTestId('cpu-card')).toHaveTextContent('25%');
  });

  it('shows the mailbox percent computed from current / limit', () => {
    render(<ResourceUsage />, { wrapper: createWrapper() });
    // 7 / 50 = 14%
    expect(screen.getByTestId('mailbox-card')).toHaveTextContent('14%');
  });

  it('renders a refresh button that is not disabled by default', () => {
    render(<ResourceUsage />, { wrapper: createWrapper() });
    expect(screen.getByTestId('refresh-button')).not.toBeDisabled();
  });
});
