import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ClusterNodeResponse } from '@k8s-hosting/api-contracts';
import type { NodeSubsystemReport } from '@/hooks/use-cluster-health';
import ClusterNodes from '../pages/ClusterNodes';

// Mock the hooks. ClusterNodes uses useClusterNodes + useNodeSubsystemHealth
// at the page level, useDeleteNode + useNodeStorage inside the card.
const mockNodes = vi.fn();
const mockSubsystem = vi.fn();
const mockDeleteMutate = vi.fn();
vi.mock('@/hooks/use-cluster-nodes', () => ({
  useClusterNodes: () => mockNodes(),
  useDeleteNode: () => ({ mutate: mockDeleteMutate, isPending: false }),
  useUpdateClusterNode: () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false }),
}));
vi.mock('@/hooks/use-cluster-health', () => ({
  useNodeSubsystemHealth: () => mockSubsystem(),
}));
vi.mock('@/hooks/use-node-storage', () => ({
  useNodeStorage: () => ({ data: undefined, isLoading: false, error: null }),
  usePatchNodeDisk: () => ({ mutate: vi.fn(), isPending: false }),
}));

function makeNode(overrides: Partial<ClusterNodeResponse> = {}): ClusterNodeResponse {
  return {
    name: 'staging1',
    displayName: null,
    role: 'server',
    canHostClientWorkloads: false,
    cordoned: false,
    drained: false,
    ingressMode: 'all',
    publicIp: '46.224.122.58',
    k3sVersion: 'v1.30.4+k3s1',
    kubeletVersion: 'v1.30.4',
    cpuMillicores: 4000,
    cpuRequestsMillicores: 1000,
    memoryBytes: 8 * 1024 ** 3,
    memoryRequestsBytes: 2 * 1024 ** 3,
    storageBytes: 100 * 1024 ** 3,
    scheduledPods: 12,
    statusConditions: [{ type: 'Ready', status: 'True', reason: '', message: '' }],
    taints: [],
    notes: null,
    lastSeenAt: new Date().toISOString(),
    existsInKubernetes: true,
    ...overrides,
  } as unknown as ClusterNodeResponse;
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ClusterNodes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ClusterNodes — health bar + collapsible node cards', () => {
  it('renders "All systems healthy" when every node is Ready and within thresholds', () => {
    mockNodes.mockReturnValue({
      data: { data: [makeNode({ name: 's1' }), makeNode({ name: 's2' })] },
      isLoading: false,
      error: null,
    });
    mockSubsystem.mockReturnValue({ data: { data: { nodes: [] } } });

    renderPage();
    const bar = screen.getByTestId('cluster-health-bar');
    expect(within(bar).getByTestId('health-all-ok')).toBeDefined();
  });

  it('shows CPU pressure chip when one node exceeds 75% CPU requests', () => {
    mockNodes.mockReturnValue({
      data: {
        data: [
          // 3500m of 4000m = 87% → amber pressure
          makeNode({ name: 'busy', cpuRequestsMillicores: 3500 }),
          makeNode({ name: 'idle' }),
        ],
      },
      isLoading: false,
      error: null,
    });
    mockSubsystem.mockReturnValue({ data: { data: { nodes: [] } } });

    renderPage();
    const bar = screen.getByTestId('cluster-health-bar');
    const cpuChip = within(bar).getByTestId('health-cpu');
    expect(cpuChip.textContent).toContain('CPU pressure: 1');
    // No memory or subsystem chips
    expect(within(bar).queryByTestId('health-memory')).toBeNull();
    expect(within(bar).queryByTestId('health-subsystem')).toBeNull();
  });

  it('escalates the CPU chip to red when >=90% on any node', () => {
    mockNodes.mockReturnValue({
      data: {
        data: [
          makeNode({ name: 'critical', cpuRequestsMillicores: 3800 }), // 95%
        ],
      },
      isLoading: false,
      error: null,
    });
    mockSubsystem.mockReturnValue({ data: { data: { nodes: [] } } });

    renderPage();
    const cpuChip = screen.getByTestId('health-cpu');
    expect(cpuChip.textContent).toMatch(/1 ≥90%/);
  });

  it('counts subsystem-degraded nodes', () => {
    const sub: NodeSubsystemReport = {
      nodeName: 'w1',
      calico: 'degraded',
      longhornCsi: 'healthy',
      csiDriverRegistered: true,
    };
    mockNodes.mockReturnValue({
      data: { data: [makeNode({ name: 'w1', role: 'worker' })] },
      isLoading: false,
      error: null,
    });
    mockSubsystem.mockReturnValue({ data: { data: { nodes: [sub] } } });

    renderPage();
    const subChip = screen.getByTestId('health-subsystem');
    expect(subChip.textContent).toContain('Worker subsystem issues: 1');
  });

  it('node card is collapsed by default; clicking the row expands the body', () => {
    mockNodes.mockReturnValue({
      data: { data: [makeNode({ name: 'staging1' })] },
      isLoading: false,
      error: null,
    });
    mockSubsystem.mockReturnValue({ data: { data: { nodes: [] } } });

    renderPage();
    expect(screen.queryByTestId('node-card-body-staging1')).toBeNull();
    const toggle = screen.getByTestId('node-card-toggle-staging1');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(screen.getByTestId('node-card-header-staging1'));
    expect(screen.getByTestId('node-card-body-staging1')).toBeDefined();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    // Toggle back via the dedicated chevron button.
    fireEvent.click(toggle);
    expect(screen.queryByTestId('node-card-body-staging1')).toBeNull();
  });

  it('clicking the Edit button does not toggle expansion', () => {
    mockNodes.mockReturnValue({
      data: { data: [makeNode({ name: 'staging1' })] },
      isLoading: false,
      error: null,
    });
    mockSubsystem.mockReturnValue({ data: { data: { nodes: [] } } });

    renderPage();
    const toggle = screen.getByTestId('node-card-toggle-staging1');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByTestId('edit-node-staging1-button'));
    // The edit modal opens — card expansion is unchanged.
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('ClusterNodes — orphan node removal', () => {
  // Confirms the bugfix: a DB-known node that has been deleted out-of-band
  // from k8s (so listNodesEnriched flips existsInKubernetes to false)
  // must be removable directly from the admin UI without going through
  // the Drain modal — which would fail on the k8s readNode 404.
  it('shows an Orphaned pill and a Remove orphan button when existsInKubernetes is false', () => {
    mockNodes.mockReturnValue({
      data: { data: [makeNode({ name: 'orphan-3', existsInKubernetes: false })] },
      isLoading: false,
      error: null,
    });
    mockSubsystem.mockReturnValue({ data: { data: { nodes: [] } } });

    renderPage();

    expect(screen.getByTestId('node-orphan-tag-orphan-3')).toBeDefined();
    expect(screen.getByTestId('remove-orphan-node-orphan-3-button')).toBeDefined();
    // The drain/edit buttons must be hidden — both would hit
    // NODE_NOT_FOUND on the k8s readNode() pre-check.
    expect(screen.queryByTestId('edit-node-orphan-3-button')).toBeNull();
    expect(screen.queryByTestId('drain-node-orphan-3-open-button')).toBeNull();
  });

  it('Remove orphan button calls the delete mutation (confirm dialog auto-accepted)', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockDeleteMutate.mockClear();
    mockNodes.mockReturnValue({
      data: { data: [makeNode({ name: 'orphan-3', existsInKubernetes: false })] },
      isLoading: false,
      error: null,
    });
    mockSubsystem.mockReturnValue({ data: { data: { nodes: [] } } });

    renderPage();
    fireEvent.click(screen.getByTestId('remove-orphan-node-orphan-3-button'));

    expect(confirmSpy).toHaveBeenCalled();
    expect(mockDeleteMutate).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it('confirm=cancel aborts the Remove orphan flow without calling delete', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mockDeleteMutate.mockClear();
    mockNodes.mockReturnValue({
      data: { data: [makeNode({ name: 'orphan-3', existsInKubernetes: false })] },
      isLoading: false,
      error: null,
    });
    mockSubsystem.mockReturnValue({ data: { data: { nodes: [] } } });

    renderPage();
    fireEvent.click(screen.getByTestId('remove-orphan-node-orphan-3-button'));

    expect(mockDeleteMutate).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
