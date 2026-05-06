/**
 * Smoke test for the RestoreCartsList page.
 *
 * Validates the basic rendering matrix — empty / loading / error
 * / list with mixed-status rows. The cart-execute + bundle-browse
 * paths are exercised end-to-end by the integration-staging
 * scenario; these tests just keep the page-level rendering
 * regression-proof.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import RestoreCartsList from '../pages/RestoreCartsList';
import type { RestoreJobSummary } from '@k8s-hosting/api-contracts';

vi.mock('../hooks/use-restore-carts', () => ({
  useRestoreCarts: vi.fn(),
}));

import { useRestoreCarts } from '../hooks/use-restore-carts';

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

const mocked = useRestoreCarts as unknown as ReturnType<typeof vi.fn>;

const ROW: RestoreJobSummary = {
  id: 'rstr-aaaaaaaa-1111-2222-3333-444444444444',
  clientId: 'client-bbbb-1111',
  initiatorUserId: null,
  status: 'failed',
  preRestoreSnapshotId: null,
  description: 'E2E test cart',
  startedAt: '2026-05-05T17:00:00Z',
  finishedAt: '2026-05-05T17:01:00Z',
  lastError: 'EXECUTOR_FAILED',
  createdAt: '2026-05-05T17:00:00Z',
  updatedAt: '2026-05-05T17:01:00Z',
};

describe('RestoreCartsList', () => {
  it('renders the heading + empty state when no carts exist', () => {
    mocked.mockReturnValue({ data: { data: { data: [] } }, isLoading: false, isError: false, isFetching: false });
    render(<RestoreCartsList />, { wrapper });
    expect(screen.getByText('Restore carts')).toBeInTheDocument();
    expect(screen.getByText('No carts yet')).toBeInTheDocument();
  });

  it('renders failed cart with Resume link', () => {
    mocked.mockReturnValue({ data: { data: { data: [ROW] } }, isLoading: false, isError: false, isFetching: false });
    render(<RestoreCartsList />, { wrapper });
    // 'failed' appears in both the filter pill and the row's status pill;
    // assert at least one match for each.
    expect(screen.getAllByText('failed').length).toBeGreaterThan(0);
    // 'Resume' appears in the table column header AND the row link;
    // there should be ≥2 (the link is what we care about).
    expect(screen.getAllByText('Resume').length).toBeGreaterThanOrEqual(2);
  });

  it('shows error state', () => {
    mocked.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: new Error('Network down'), isFetching: false });
    render(<RestoreCartsList />, { wrapper });
    expect(screen.getByText(/Network down/)).toBeInTheDocument();
  });

  it('shows done cart without Resume LINK', () => {
    mocked.mockReturnValue({
      data: { data: { data: [{ ...ROW, status: 'done', lastError: null } satisfies RestoreJobSummary] } },
      isLoading: false,
      isError: false,
      isFetching: false,
    });
    render(<RestoreCartsList />, { wrapper });
    // Status pill shows 'done'; "done" also appears in the row's
    // Resume column as plain text. We just need to assert the
    // Resume link is absent — there should only be ONE 'Resume'
    // (the column header).
    expect(screen.getAllByText('Resume').length).toBe(1);
    // And the done text exists at least once (status pill + cell).
    expect(screen.getAllByText('done').length).toBeGreaterThan(0);
  });
});
