import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import SearchableClientSelect from '../components/ui/SearchableClientSelect';
import { apiFetch } from '@/lib/api-client';

vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

const mockApiFetch = vi.mocked(apiFetch);

const MOCK_CLIENTS = [
  {
    id: 'client-1',
    companyName: 'Acme Corp',
    companyEmail: 'admin@acme.com',
    contactEmail: null,
    kubernetesNamespace: 'acme',
    planId: 'plan-1',
    regionId: 'region-1',
    status: 'active' as const,
    createdBy: null,
    subscriptionExpiresAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'client-2',
    companyName: 'Beta Inc',
    companyEmail: 'admin@beta.com',
    contactEmail: null,
    kubernetesNamespace: 'beta',
    planId: 'plan-1',
    regionId: 'region-1',
    status: 'active' as const,
    createdBy: null,
    subscriptionExpiresAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApiFetch.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/clients')) {
      const hasSearch = url.includes('search=');
      if (hasSearch) {
        const searchMatch = url.match(/search=([^&]*)/);
        const searchTerm = searchMatch ? decodeURIComponent(searchMatch[1]) : '';
        const filtered = MOCK_CLIENTS.filter((c) =>
          c.companyName.toLowerCase().includes(searchTerm.toLowerCase()),
        );
        return Promise.resolve({
          data: filtered,
          pagination: { total_count: filtered.length, cursor: null, has_more: false, page_size: 20 },
        });
      }
      // limit=0 query (no search) — return empty
      return Promise.resolve({
        data: [],
        pagination: { total_count: 0, cursor: null, has_more: false, page_size: 0 },
      });
    }
    return Promise.resolve({ data: null });
  });
});

describe('SearchableClientSelect', () => {
  it('renders search input with placeholder', () => {
    const onSelect = vi.fn();
    render(
      <SearchableClientSelect selectedClientId={null} onSelect={onSelect} />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByTestId('client-search-select')).toBeInTheDocument();
    expect(screen.getByTestId('client-search-input')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search clients...')).toBeInTheDocument();
  });

  it('accepts a custom placeholder', () => {
    const onSelect = vi.fn();
    render(
      <SearchableClientSelect
        selectedClientId={null}
        onSelect={onSelect}
        placeholder="Find a client..."
      />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByPlaceholderText('Find a client...')).toBeInTheDocument();
  });

  it('does not show dropdown when input is empty', () => {
    const onSelect = vi.fn();
    render(
      <SearchableClientSelect selectedClientId={null} onSelect={onSelect} />,
      { wrapper: createWrapper() },
    );
    expect(screen.queryByTestId('client-search-dropdown')).not.toBeInTheDocument();
  });

  it('shows dropdown with results after typing', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <SearchableClientSelect selectedClientId={null} onSelect={onSelect} />,
      { wrapper: createWrapper() },
    );

    await user.type(screen.getByTestId('client-search-input'), 'Acme');

    await waitFor(() => {
      expect(screen.getByTestId('client-search-dropdown')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByTestId('client-search-results')).toBeInTheDocument();
      expect(screen.getByText('Acme Corp')).toBeInTheDocument();
      expect(screen.getByText('admin@acme.com')).toBeInTheDocument();
    });
  });

  it('calls onSelect when a client option is clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <SearchableClientSelect selectedClientId={null} onSelect={onSelect} />,
      { wrapper: createWrapper() },
    );

    await user.type(screen.getByTestId('client-search-input'), 'Acme');

    await waitFor(() => {
      expect(screen.getByTestId('client-option-client-1')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('client-option-client-1'));
    expect(onSelect).toHaveBeenCalledWith('client-1');
  });

  it('shows "No clients found" when search yields no results', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <SearchableClientSelect selectedClientId={null} onSelect={onSelect} />,
      { wrapper: createWrapper() },
    );

    await user.type(screen.getByTestId('client-search-input'), 'zzzznonexistent');

    await waitFor(() => {
      expect(screen.getByTestId('client-search-empty')).toBeInTheDocument();
      expect(screen.getByText('No clients found')).toBeInTheDocument();
    });
  });

  it('shows selected client name and clear button when a client is selected', async () => {
    const onSelect = vi.fn();
    // Mock the single client fetch
    mockApiFetch.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.match(/\/clients\/client-1$/)) {
        return Promise.resolve({ data: MOCK_CLIENTS[0] });
      }
      return Promise.resolve({
        data: [],
        pagination: { total_count: 0, cursor: null, has_more: false, page_size: 0 },
      });
    });

    render(
      <SearchableClientSelect selectedClientId="client-1" onSelect={onSelect} />,
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(screen.getByTestId('client-search-selected')).toBeInTheDocument();
      expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    });

    expect(screen.getByTestId('client-search-clear')).toBeInTheDocument();
  });

  it('calls onSelect(null) when clear button is clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    mockApiFetch.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.match(/\/clients\/client-1$/)) {
        return Promise.resolve({ data: MOCK_CLIENTS[0] });
      }
      return Promise.resolve({
        data: [],
        pagination: { total_count: 0, cursor: null, has_more: false, page_size: 0 },
      });
    });

    render(
      <SearchableClientSelect selectedClientId="client-1" onSelect={onSelect} />,
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(screen.getByTestId('client-search-clear')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('client-search-clear'));
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});
