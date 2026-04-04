import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SystemHealthBanner from '../components/SystemHealthBanner';

// Mock the dashboard hook
const mockUsePlatformStatus = vi.fn();
vi.mock('@/hooks/use-dashboard', () => ({
  usePlatformStatus: () => mockUsePlatformStatus(),
}));

function renderBanner() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SystemHealthBanner />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SystemHealthBanner', () => {
  it('does not render when status is healthy', () => {
    mockUsePlatformStatus.mockReturnValue({
      data: { data: { status: 'healthy', version: '0.1.0', services: { kubernetes: 'ok', redis: 'ok', database: 'ok' } } },
    });
    renderBanner();
    expect(screen.queryByTestId('system-health-banner')).toBeNull();
  });

  it('does not render when data is loading', () => {
    mockUsePlatformStatus.mockReturnValue({ data: undefined });
    renderBanner();
    expect(screen.queryByTestId('system-health-banner')).toBeNull();
  });

  it('renders warning banner when status is degraded', () => {
    mockUsePlatformStatus.mockReturnValue({
      data: { data: { status: 'degraded', version: '0.1.0', services: { kubernetes: 'degraded', redis: 'ok', database: 'ok' } } },
    });
    renderBanner();
    const banner = screen.getByTestId('system-health-banner');
    expect(banner).toBeDefined();
    expect(banner.textContent).toContain('degraded');
    expect(banner.textContent).toContain('kubernetes');
  });

  it('renders error banner when status is unhealthy', () => {
    mockUsePlatformStatus.mockReturnValue({
      data: { data: { status: 'unhealthy', version: '0.1.0', services: { kubernetes: 'error', redis: 'ok', database: 'ok' } } },
    });
    renderBanner();
    const banner = screen.getByTestId('system-health-banner');
    expect(banner).toBeDefined();
    expect(banner.textContent).toContain('unhealthy');
    expect(banner.textContent).toContain('kubernetes');
  });

  it('shows multiple failed services', () => {
    mockUsePlatformStatus.mockReturnValue({
      data: { data: { status: 'unhealthy', version: '0.1.0', services: { kubernetes: 'error', redis: 'error', database: 'ok' } } },
    });
    renderBanner();
    const banner = screen.getByTestId('system-health-banner');
    expect(banner.textContent).toContain('kubernetes');
    expect(banner.textContent).toContain('redis');
  });

  it('can be dismissed', () => {
    mockUsePlatformStatus.mockReturnValue({
      data: { data: { status: 'unhealthy', version: '0.1.0', services: { kubernetes: 'error', redis: 'ok', database: 'ok' } } },
    });
    renderBanner();
    expect(screen.getByTestId('system-health-banner')).toBeDefined();
    fireEvent.click(screen.getByTestId('system-health-dismiss'));
    expect(screen.queryByTestId('system-health-banner')).toBeNull();
  });

  it('has link to health dashboard', () => {
    mockUsePlatformStatus.mockReturnValue({
      data: { data: { status: 'degraded', version: '0.1.0', services: { kubernetes: 'degraded', redis: 'ok', database: 'ok' } } },
    });
    renderBanner();
    const link = screen.getByText('View details');
    expect(link).toBeDefined();
    expect(link.getAttribute('href')).toBe('/monitoring/health');
  });
});
