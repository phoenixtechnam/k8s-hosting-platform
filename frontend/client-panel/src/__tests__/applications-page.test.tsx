import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Applications from '../pages/Applications';

vi.mock('../hooks/use-auth', () => ({
  useAuth: vi.fn(() => ({
    user: { id: 'client-1', email: 'test@example.com', fullName: 'Test User', role: 'client' },
    token: 'test-token',
    isAuthenticated: true,
    isLoading: false,
    error: null,
    login: vi.fn(),
    logout: vi.fn(),
    initialize: vi.fn(),
  })),
}));

vi.mock('../hooks/use-client-context', () => ({
  useClientContext: vi.fn(() => ({
    clientId: 'client-1',
    clientName: 'Test Company',
    isLoading: false,
  })),
}));

vi.mock('../hooks/use-deployments', () => ({
  useDeployments: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
  useCreateDeployment: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useUpdateDeployment: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useDeleteDeployment: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useRestoreDeployment: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  usePermanentDeleteDeployment: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}));

vi.mock('../hooks/use-catalog', () => ({
  useCatalog: vi.fn(() => ({ data: { data: [] }, isLoading: false, isError: false, error: null })),
  useCatalogEntryVersions: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
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
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Applications Page', () => {
  it('renders the heading', () => {
    renderWithProviders(<Applications />);
    expect(screen.getByTestId('applications-heading')).toHaveTextContent('Applications');
  });

  it('renders Catalog and Installed tabs', () => {
    renderWithProviders(<Applications />);
    expect(screen.getByTestId('tab-catalog')).toBeInTheDocument();
    expect(screen.getByTestId('tab-installed')).toBeInTheDocument();
    expect(screen.getByText('Catalog')).toBeInTheDocument();
    expect(screen.getByText('Installed')).toBeInTheDocument();
  });

  it('shows tab bar', () => {
    renderWithProviders(<Applications />);
    expect(screen.getByTestId('tab-bar')).toBeInTheDocument();
  });

  it('defaults to Catalog tab', () => {
    renderWithProviders(<Applications />);
    const catalogTab = screen.getByTestId('tab-catalog');
    expect(catalogTab.className).toContain('border-');
  });

  it('switches to Installed tab on click', () => {
    renderWithProviders(<Applications />);
    const installedTab = screen.getByTestId('tab-installed');
    fireEvent.click(installedTab);
    expect(installedTab.className).toContain('border-');
  });
});
