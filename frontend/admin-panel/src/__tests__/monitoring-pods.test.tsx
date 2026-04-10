import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Monitoring from '../pages/Monitoring';

const usePodsMock = vi.fn();

vi.mock('../hooks/use-pods', () => ({
  usePods: () => usePodsMock(),
}));

// Minimal mocks for hooks the component also uses
vi.mock('../hooks/use-dashboard', () => ({
  usePlatformStatus: () => ({
    data: { data: { status: 'healthy' } },
    isLoading: false,
  }),
}));

vi.mock('../hooks/use-audit-logs', () => ({
  useAuditLogs: () => ({
    data: { data: [], pagination: { total_count: 0, has_more: false, cursor: null, page_size: 0 } },
    isLoading: false,
  }),
}));

const SAMPLE_PODS = [
  { name: 'web-abc', namespace: 'client-acme', phase: 'Running', classification: 'running' as const, isOrphaned: false, ready: true, restarts: 0, waitingReason: null, node: 'k8s-local', age: '2026-04-09T10:00:00Z' },
  { name: 'db-xyz', namespace: 'client-acme', phase: 'Running', classification: 'not_ready' as const, isOrphaned: false, ready: false, restarts: 3, waitingReason: null, node: 'k8s-local', age: '2026-04-09T11:00:00Z' },
  { name: 'fm-orphan', namespace: 'client-smoke-test-123', phase: 'Pending', classification: 'orphaned' as const, isOrphaned: true, ready: false, restarts: 0, waitingReason: 'FailedScheduling', node: null, age: '2026-04-09T12:00:00Z' },
  { name: 'backup-done', namespace: 'client-acme', phase: 'Succeeded', classification: 'completed' as const, isOrphaned: false, ready: false, restarts: 0, waitingReason: null, node: 'k8s-local', age: '2026-04-09T13:00:00Z' },
  { name: 'crash-loop', namespace: 'client-acme', phase: 'Failed', classification: 'failed' as const, isOrphaned: false, ready: false, restarts: 12, waitingReason: 'CrashLoopBackOff', node: 'k8s-local', age: '2026-04-09T14:00:00Z' },
];

function wrap(children: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Monitoring Pods tab', () => {
  beforeEach(() => {
    usePodsMock.mockReturnValue({
      data: {
        data: {
          capacity: { total: 110, allocatable: 110, used: 45 },
          pods: SAMPLE_PODS,
        },
      },
      isLoading: false,
      isError: false,
    });
  });

  it('renders the Pod Usage stat card with used/allocatable', () => {
    render(wrap(<Monitoring />));
    // Pod Usage tile should show "45 / 110"
    expect(screen.getByText('Pod Usage')).toBeInTheDocument();
    expect(screen.getByText('45 / 110')).toBeInTheDocument();
  });

  it('renders the Pods tab button', () => {
    render(wrap(<Monitoring />));
    expect(screen.getByTestId('tab-pods')).toBeInTheDocument();
  });

  it('switches to the Pods tab and shows the table', async () => {
    const user = userEvent.setup();
    render(wrap(<Monitoring />));
    await user.click(screen.getByTestId('tab-pods'));
    expect(screen.getByTestId('pods-tab')).toBeInTheDocument();
    expect(screen.getByText('web-abc')).toBeInTheDocument();
    expect(screen.getByText('fm-orphan')).toBeInTheDocument();
    expect(screen.getByText('crash-loop')).toBeInTheDocument();
  });

  it('shows classification badges on each row', async () => {
    const user = userEvent.setup();
    render(wrap(<Monitoring />));
    await user.click(screen.getByTestId('tab-pods'));
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Orphaned')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });

  it('filters pods by classification', async () => {
    const user = userEvent.setup();
    render(wrap(<Monitoring />));
    await user.click(screen.getByTestId('tab-pods'));
    await user.click(screen.getByTestId('pod-filter-orphaned'));
    expect(screen.getByText('fm-orphan')).toBeInTheDocument();
    expect(screen.queryByText('web-abc')).not.toBeInTheDocument();
    expect(screen.getByTestId('pods-count')).toHaveTextContent('1 of 5');
  });

  it('searches pods by name', async () => {
    const user = userEvent.setup();
    render(wrap(<Monitoring />));
    await user.click(screen.getByTestId('tab-pods'));
    await user.type(screen.getByTestId('pod-search'), 'crash');
    expect(screen.getByText('crash-loop')).toBeInTheDocument();
    expect(screen.queryByText('web-abc')).not.toBeInTheDocument();
  });

  it('searches pods by namespace', async () => {
    const user = userEvent.setup();
    render(wrap(<Monitoring />));
    await user.click(screen.getByTestId('tab-pods'));
    await user.type(screen.getByTestId('pod-search'), 'smoke-test');
    expect(screen.getByText('fm-orphan')).toBeInTheDocument();
    expect(screen.queryByText('web-abc')).not.toBeInTheDocument();
  });

  it('shows filter group counts in the button labels', async () => {
    const user = userEvent.setup();
    render(wrap(<Monitoring />));
    await user.click(screen.getByTestId('tab-pods'));
    expect(screen.getByTestId('pod-filter-all')).toHaveTextContent('All (5)');
    expect(screen.getByTestId('pod-filter-running')).toHaveTextContent('Running (1)');
    expect(screen.getByTestId('pod-filter-orphaned')).toHaveTextContent('Orphaned (1)');
    expect(screen.getByTestId('pod-filter-failed')).toHaveTextContent('Failed (1)');
  });

  it('shows the loading state', async () => {
    usePodsMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    });
    const user = userEvent.setup();
    render(wrap(<Monitoring />));
    await user.click(screen.getByTestId('tab-pods'));
    expect(screen.getByTestId('pods-loading')).toBeInTheDocument();
  });

  it('shows the error state', async () => {
    usePodsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });
    const user = userEvent.setup();
    render(wrap(<Monitoring />));
    await user.click(screen.getByTestId('tab-pods'));
    expect(screen.getByTestId('pods-error')).toBeInTheDocument();
  });
});
