import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { GetPlatformStoragePolicyResponse } from '@k8s-hosting/api-contracts';
import PlatformStoragePolicyCard from '../components/PlatformStoragePolicyCard';

// The card uses two hooks; we stub them so the test stays focused on
// the modal-open timing instead of HTTP plumbing.
const mockUsePolicy = vi.fn();
const mockMutateAsync = vi.fn();
const mockUpdateState = { isPending: false, isError: false, mutateAsync: mockMutateAsync };

vi.mock('@/hooks/use-platform-storage-policy', () => ({
  usePlatformStoragePolicy: () => mockUsePolicy(),
  useUpdatePlatformStoragePolicy: () => mockUpdateState,
}));

// The progress modal itself polls the runs endpoint via apiFetch; we
// stub apiFetch so the modal renders without making real network calls.
vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn().mockResolvedValue({
    data: {
      id: 'run-1',
      tier: 'ha',
      status: 'running',
      patchOutcome: null,
      convergence: null,
      startedAt: new Date().toISOString(),
    },
  }),
}));

function policyResponse(systemTier: 'local' | 'ha' = 'local') {
  const payload = {
    policy: {
      systemTier,
      pinnedByAdmin: true,
      lastAppliedAt: null,
      lastAppliedBy: null,
      updatedAt: '2026-04-26T00:00:00.000Z',
    },
    clusterState: {
      readyServerCount: 3,
      totalNodeCount: 4,
      recommendedTier: 'ha' as const,
      volumes: [],
    },
  } satisfies GetPlatformStoragePolicyResponse;
  return { data: { data: payload } };
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PlatformStoragePolicyCard />
    </QueryClientProvider>,
  );
}

describe('PlatformStoragePolicyCard — immediate modal open', () => {
  beforeEach(() => {
    mockUsePolicy.mockReset();
    mockMutateAsync.mockReset();
    mockUsePolicy.mockReturnValue(policyResponse('local'));
  });

  it('opens the progress modal synchronously on Confirm, before the PATCH resolves', async () => {
    // Hold the mutation pending so we can assert the modal opens
    // BEFORE the network call returns a runId — that's the whole
    // point: the operator must see immediate feedback when clicking
    // Confirm even though the synchronous patch phase takes seconds.
    let resolveMutation: (resp: { data: { runId: string } }) => void = () => {};
    mockMutateAsync.mockImplementation(
      () => new Promise((resolve) => { resolveMutation = resolve; }),
    );

    renderCard();
    fireEvent.click(screen.getByText(/Apply HA \(3 replicas\)/));
    fireEvent.click(screen.getByText(/Apply High Availability/));

    // Modal is visible. Header shows the Submitting… placeholder
    // because the mutation hasn't resolved yet.
    expect(await screen.findByTestId('apply-ha-progress-modal')).toBeDefined();
    expect(screen.getByText(/submitting/i)).toBeDefined();
    // The mutation was kicked off — but is still pending.
    expect(mockMutateAsync).toHaveBeenCalledTimes(1);

    // Now resolve the PATCH. Modal stays open and transitions out of
    // the placeholder state once the polling effect picks up the run.
    resolveMutation({ data: { runId: 'run-1' } });
    await waitFor(() => {
      // The polling effect has fired and apiFetch was called with the runId.
      expect(screen.getByTestId('apply-ha-progress-modal')).toBeDefined();
    });
  });

  it('closes the modal if the mutation rejects so the error banner is reachable', async () => {
    mockMutateAsync.mockRejectedValueOnce(new Error('patch failed'));

    renderCard();
    fireEvent.click(screen.getByText(/Apply HA \(3 replicas\)/));
    fireEvent.click(screen.getByText(/Apply High Availability/));

    // Modal flashes open immediately…
    expect(await screen.findByTestId('apply-ha-progress-modal')).toBeDefined();
    // …and then closes when the rejection propagates.
    await waitFor(() => {
      expect(screen.queryByTestId('apply-ha-progress-modal')).toBeNull();
    });
  });

  it('closes the modal if the backend response omits runId (very old backend)', async () => {
    // Defensive: a pre-runId backend would resolve with just `policy`,
    // no runId. We should close the modal so the operator isn't stuck
    // on the placeholder forever.
    mockMutateAsync.mockResolvedValueOnce({ data: { policy: {} } });

    renderCard();
    fireEvent.click(screen.getByText(/Apply HA \(3 replicas\)/));
    fireEvent.click(screen.getByText(/Apply High Availability/));

    await waitFor(() => {
      expect(screen.queryByTestId('apply-ha-progress-modal')).toBeNull();
    });
  });
});
