import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import DnsServers from '../pages/DnsServers';
import { apiFetch } from '@/lib/api-client';

vi.mock('@/lib/api-client', () => ({
  API_BASE: 'http://localhost:3000',
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
});

describe('DnsServers page', () => {
  it('shows loading state while fetching', () => {
    mockApiFetch.mockReturnValue(new Promise(() => {}));
    render(<DnsServers />, { wrapper: createWrapper() });
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeInTheDocument();
  });

  it('renders page heading and description', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<DnsServers />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText('DNS Servers')).toBeInTheDocument();
    });
    expect(screen.getByText('Manage DNS provider groups and servers for domain provisioning.')).toBeInTheDocument();
  });

  it('shows empty state when no servers exist', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<DnsServers />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText('No DNS servers configured.')).toBeInTheDocument();
    });
  });

  it('shows add server button', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<DnsServers />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('add-dns-server-button')).toBeInTheDocument();
    });
    expect(screen.getByText('Add Server')).toBeInTheDocument();
  });

  it('shows add form when button is clicked', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<DnsServers />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('add-dns-server-button')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('add-dns-server-button'));
    expect(screen.getByTestId('add-dns-server-form')).toBeInTheDocument();
    expect(screen.getByTestId('dns-server-name-input')).toBeInTheDocument();
    expect(screen.getByTestId('dns-provider-select')).toBeInTheDocument();
  });

  it('renders server rows when data is returned', async () => {
    mockApiFetch.mockResolvedValue({
      data: [
        {
          id: 'dns-1',
          displayName: 'Primary DNS',
          providerType: 'powerdns',
          zoneDefaultKind: 'Native',
          groupId: null,
          role: 'primary',
          isDefault: true,
          enabled: true,
          lastHealthCheck: null,
          lastHealthStatus: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    render(<DnsServers />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('dns-server-dns-1')).toBeInTheDocument();
    });
    expect(screen.getByText('Primary DNS')).toBeInTheDocument();
    expect(screen.getByText('powerdns')).toBeInTheDocument();
  });
});
