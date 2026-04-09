import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import ResourceMetricsModal from '../components/ResourceMetricsModal';

vi.mock('../hooks/use-resource-metrics', () => ({
  useResourceMetrics: vi.fn(() => ({
    data: {
      data: {
        cpu: { inUse: 0.25, reserved: 0.5, available: 1 },
        memory: { inUse: 0.5, reserved: 1, available: 2 },
        storage: { inUse: 2, reserved: 5, available: 10 },
        lastUpdatedAt: new Date().toISOString(),
      },
    },
    isLoading: false,
  })),
  useRefreshMetrics: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

vi.mock('../hooks/use-client-context', () => ({
  useClientContext: vi.fn(() => ({ clientId: 'c1', clientName: 'Test', isLoading: false })),
}));

// Mock useMailboxUsage so the modal has data to render the mail row
const mailboxUsageMock = vi.fn(() => ({
  data: { data: { limit: 20, current: 7, remaining: 13, source: 'plan' } },
  isLoading: false,
}));
vi.mock('../hooks/use-email', () => ({
  useMailboxUsage: () => mailboxUsageMock(),
}));

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe('ResourceMetricsModal — Mail accounts row', () => {
  it('renders a Mail accounts row showing current/limit when open', () => {
    render(<ResourceMetricsModal open={true} onClose={() => {}} />, { wrapper: createWrapper() });
    expect(screen.getByText('Mail accounts')).toBeInTheDocument();
    expect(screen.getByTestId('mail-accounts-count')).toHaveTextContent('7 / 20');
  });

  it('hides the Mail accounts row when the usage query errors out or returns undefined', () => {
    mailboxUsageMock.mockReturnValueOnce({
      data: undefined as never,
      isLoading: false,
    });
    render(<ResourceMetricsModal open={true} onClose={() => {}} />, { wrapper: createWrapper() });
    expect(screen.queryByText('Mail accounts')).not.toBeInTheDocument();
  });

  it('does not render anything when the modal is closed', () => {
    render(<ResourceMetricsModal open={false} onClose={() => {}} />, { wrapper: createWrapper() });
    expect(screen.queryByText('Mail accounts')).not.toBeInTheDocument();
  });
});
