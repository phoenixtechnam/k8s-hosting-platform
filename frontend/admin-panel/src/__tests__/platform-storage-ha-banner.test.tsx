import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { GetPlatformStoragePolicyResponse } from '@k8s-hosting/api-contracts';
import PlatformStorageHaBanner from '../components/PlatformStorageHaBanner';

const mockUsePolicy = vi.fn();
vi.mock('@/hooks/use-platform-storage-policy', () => ({
  usePlatformStoragePolicy: () => mockUsePolicy(),
}));

function policyResponse(opts: {
  systemTier: 'local' | 'ha';
  pinnedByAdmin: boolean;
  recommendedTier: 'local' | 'ha';
  readyServers?: number;
  totalNodes?: number;
}) {
  const payload = {
    policy: {
      systemTier: opts.systemTier,
      pinnedByAdmin: opts.pinnedByAdmin,
      lastAppliedAt: null,
      lastAppliedBy: null,
      updatedAt: '2026-04-26T00:00:00.000Z',
    },
    clusterState: {
      readyServerCount: opts.readyServers ?? 3,
      totalNodeCount: opts.totalNodes ?? 4,
      recommendedTier: opts.recommendedTier,
      volumes: [],
    },
  } satisfies GetPlatformStoragePolicyResponse;
  return { data: { data: payload } };
}

function renderBanner() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PlatformStorageHaBanner />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PlatformStorageHaBanner', () => {
  beforeEach(() => {
    mockUsePolicy.mockReset();
    window.sessionStorage.clear();
  });

  it('does not render while data is loading', () => {
    mockUsePolicy.mockReturnValue({ data: undefined });
    renderBanner();
    expect(screen.queryByTestId('platform-storage-ha-banner')).toBeNull();
  });

  it('does not render when recommendedTier is local', () => {
    mockUsePolicy.mockReturnValue(policyResponse({
      systemTier: 'local',
      pinnedByAdmin: false,
      recommendedTier: 'local',
      readyServers: 2,
    }));
    renderBanner();
    expect(screen.queryByTestId('platform-storage-ha-banner')).toBeNull();
  });

  it('does not render when systemTier is already ha', () => {
    mockUsePolicy.mockReturnValue(policyResponse({
      systemTier: 'ha',
      pinnedByAdmin: false,
      recommendedTier: 'ha',
    }));
    renderBanner();
    expect(screen.queryByTestId('platform-storage-ha-banner')).toBeNull();
  });

  it('does not render when pinnedByAdmin (operator opted out)', () => {
    mockUsePolicy.mockReturnValue(policyResponse({
      systemTier: 'local',
      pinnedByAdmin: true,
      recommendedTier: 'ha',
    }));
    renderBanner();
    expect(screen.queryByTestId('platform-storage-ha-banner')).toBeNull();
  });

  it('renders when local + ha-recommendation + not pinned', () => {
    mockUsePolicy.mockReturnValue(policyResponse({
      systemTier: 'local',
      pinnedByAdmin: false,
      recommendedTier: 'ha',
      readyServers: 3,
      totalNodes: 4,
    }));
    renderBanner();
    const banner = screen.getByTestId('platform-storage-ha-banner');
    expect(banner).toBeDefined();
    expect(banner.textContent).toContain('Cluster reached HA size');
    expect(banner.textContent).toContain('3 of 4');
    expect(banner.textContent).toContain('Reversible');
  });

  it('links to /settings/storage', () => {
    mockUsePolicy.mockReturnValue(policyResponse({
      systemTier: 'local',
      pinnedByAdmin: false,
      recommendedTier: 'ha',
    }));
    renderBanner();
    const link = screen.getByTestId('platform-storage-ha-banner-link');
    expect(link.getAttribute('href')).toBe('/settings/storage');
  });

  it('can be dismissed', () => {
    mockUsePolicy.mockReturnValue(policyResponse({
      systemTier: 'local',
      pinnedByAdmin: false,
      recommendedTier: 'ha',
    }));
    renderBanner();
    expect(screen.getByTestId('platform-storage-ha-banner')).toBeDefined();
    fireEvent.click(screen.getByTestId('platform-storage-ha-banner-dismiss'));
    expect(screen.queryByTestId('platform-storage-ha-banner')).toBeNull();
  });

  it('dismiss persists across remounts via sessionStorage', () => {
    mockUsePolicy.mockReturnValue(policyResponse({
      systemTier: 'local',
      pinnedByAdmin: false,
      recommendedTier: 'ha',
    }));
    const first = renderBanner();
    fireEvent.click(screen.getByTestId('platform-storage-ha-banner-dismiss'));
    first.unmount();
    renderBanner();
    expect(screen.queryByTestId('platform-storage-ha-banner')).toBeNull();
  });
});
