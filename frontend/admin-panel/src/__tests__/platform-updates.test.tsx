import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import UpdateBanner from '../components/UpdateBanner';
import Settings from '../pages/Settings';

const mockMutate = vi.fn();
const mockUpdateSettingsMutate = vi.fn();

const mockVersionData = {
  data: {
    currentVersion: '0.1.0',
    latestVersion: '0.2.0',
    updateAvailable: true,
    environment: 'production',
    autoUpdate: false,
    lastCheckedAt: '2026-03-28T12:00:00Z',
  },
};

const mockVersionNoUpdate = {
  data: {
    currentVersion: '0.2.0',
    latestVersion: '0.2.0',
    updateAvailable: false,
    environment: 'production',
    autoUpdate: true,
    lastCheckedAt: '2026-03-28T12:00:00Z',
  },
};

vi.mock('../hooks/use-platform-updates', () => ({
  usePlatformVersion: vi.fn(() => ({
    data: mockVersionData,
    isLoading: false,
    refetch: vi.fn(),
  })),
  useUpdateSettings: vi.fn(() => ({
    mutate: mockUpdateSettingsMutate,
    isPending: false,
    isSuccess: false,
    isError: false,
  })),
  useTriggerUpdate: vi.fn(() => ({
    mutate: mockMutate,
    isPending: false,
    isSuccess: false,
    isError: false,
  })),
}));

vi.mock('../hooks/use-auth', () => ({
  useAuth: vi.fn(() => ({
    user: { id: 'admin-1', email: 'admin@k8s-platform.test', fullName: 'Admin User', role: 'admin' },
    token: 'test-token', isAuthenticated: true, isLoading: false, error: null,
    login: vi.fn(), logout: vi.fn(), initialize: vi.fn(),
  })),
}));

vi.mock('../hooks/use-dashboard', () => ({
  usePlatformStatus: vi.fn(() => ({
    data: { data: { status: 'healthy', version: '0.1.0', timestamp: '2026-03-27T00:00:00Z' } },
    isLoading: false,
  })),
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

describe('UpdateBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders when update is available', () => {
    renderWithProviders(<UpdateBanner />);
    expect(screen.getByTestId('update-banner')).toBeInTheDocument();
    expect(screen.getByText(/0\.2\.0/)).toBeInTheDocument();
    expect(screen.getByText(/0\.1\.0/)).toBeInTheDocument();
  });

  it('does not render when no update is available', async () => {
    const mod = await import('../hooks/use-platform-updates');
    vi.mocked(mod.usePlatformVersion).mockReturnValue({
      data: mockVersionNoUpdate,
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof mod.usePlatformVersion>);

    const { container } = renderWithProviders(<UpdateBanner />);
    expect(container.querySelector('[data-testid="update-banner"]')).toBeNull();

    // Reset mock for subsequent tests
    vi.mocked(mod.usePlatformVersion).mockReturnValue({
      data: mockVersionData,
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof mod.usePlatformVersion>);
  });

  it('"Update Now" button triggers mutation', () => {
    renderWithProviders(<UpdateBanner />);
    const btn = screen.getByTestId('update-banner-trigger');
    fireEvent.click(btn);
    expect(mockMutate).toHaveBeenCalledTimes(1);
  });

  it('"Dismiss" hides the banner', async () => {
    renderWithProviders(<UpdateBanner />);
    expect(screen.getByTestId('update-banner')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('update-banner-dismiss'));
    await waitFor(() => {
      expect(screen.queryByTestId('update-banner')).not.toBeInTheDocument();
    });
  });
});

describe('Settings page - Platform Updates section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows Platform Updates section', () => {
    renderWithProviders(<Settings />);
    expect(screen.getByTestId('platform-updates-section')).toBeInTheDocument();
    expect(screen.getByText('Platform Updates')).toBeInTheDocument();
  });

  it('shows version information', () => {
    renderWithProviders(<Settings />);
    expect(screen.getByTestId('current-version')).toHaveTextContent('0.1.0');
    expect(screen.getByTestId('latest-version')).toHaveTextContent('0.2.0');
    expect(screen.getByTestId('environment')).toHaveTextContent('production');
  });

  it('auto-update toggle calls updateSettings mutation', () => {
    renderWithProviders(<Settings />);
    const toggle = screen.getByTestId('auto-update-toggle');
    fireEvent.click(toggle);
    expect(mockUpdateSettingsMutate).toHaveBeenCalledWith(true);
  });
});
