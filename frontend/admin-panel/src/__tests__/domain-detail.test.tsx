import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import DomainDetail from '../pages/DomainDetail';
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

const MOCK_DOMAIN = {
  id: 'domain-1',
  clientId: 'client-1',
  domainName: 'example.com',
  status: 'active',
  dnsMode: 'cname',
  sslAutoRenew: 1,
  createdAt: '2026-01-10T00:00:00Z',
};

const MOCK_DNS_RECORDS = [
  {
    id: 'rec-1',
    domainId: 'domain-1',
    recordType: 'A',
    recordName: '@',
    recordValue: '192.168.1.1',
    ttl: 3600,
    priority: null,
    weight: null,
    port: null,
    updatedAt: '2026-01-10T00:00:00Z',
  },
  {
    id: 'rec-2',
    domainId: 'domain-1',
    recordType: 'MX',
    recordName: 'mail',
    recordValue: 'mail.example.com',
    ttl: 3600,
    priority: 10,
    weight: null,
    port: null,
    updatedAt: '2026-01-10T00:00:00Z',
  },
];

// Hosting Settings and Protected Directories data removed — those tabs
// were moved to the per-route RouteDetail page.

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/clients/client-1/domains/domain-1']}>
          <Routes>
            <Route path="/clients/:clientId/domains/:domainId" element={children} />
            <Route path="/domains" element={<div>Domains List</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

function setupMockApi() {
  mockApiFetch.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/domains') && !url.includes('/dns-records')) {
      return Promise.resolve({
        data: [MOCK_DOMAIN],
        pagination: { total_count: 1, cursor: null, has_more: false, page_size: 100 },
      });
    }
    if (typeof url === 'string' && url.includes('/dns-records')) {
      return Promise.resolve({ data: MOCK_DNS_RECORDS });
    }
    return Promise.resolve({ data: [] });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DomainDetail page', () => {
  it('renders domain name and back link', async () => {
    setupMockApi();
    render(<DomainDetail />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('domain-name-heading')).toHaveTextContent('example.com');
    });
    expect(screen.getByTestId('back-to-domains')).toBeInTheDocument();
  });

  it('shows 3 tabs: Routing, DNS Records, SSL/TLS', async () => {
    setupMockApi();
    render(<DomainDetail />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('tab-routing')).toBeInTheDocument();
    });
    expect(screen.getByTestId('tab-dns')).toBeInTheDocument();
    expect(screen.getByTestId('tab-ssl')).toBeInTheDocument();
  });

  it('shows "domain not found" for invalid domain', async () => {
    mockApiFetch.mockResolvedValue({
      data: [],
      pagination: { total_count: 0, cursor: null, has_more: false, page_size: 100 },
    });
    render(<DomainDetail />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('domain-not-found')).toBeInTheDocument();
    });
  });
});

describe('DNS Records tab', () => {
  const switchToDnsTab = async () => {
    await waitFor(() => {
      expect(screen.getByTestId('tab-dns')).toBeInTheDocument();
    });
    await userEvent.setup().click(screen.getByTestId('tab-dns'));
  };

  it('renders DNS records table', async () => {
    setupMockApi();
    render(<DomainDetail />, { wrapper: createWrapper() });
    await switchToDnsTab();

    await waitFor(() => {
      expect(screen.getByTestId('dns-records-table')).toBeInTheDocument();
    });
    expect(screen.getByText('192.168.1.1')).toBeInTheDocument();
    expect(screen.getByText('mail.example.com')).toBeInTheDocument();
  });

  it('has an Add Record button that shows form', async () => {
    setupMockApi();
    const user = userEvent.setup();
    render(<DomainDetail />, { wrapper: createWrapper() });
    await switchToDnsTab();

    await waitFor(() => {
      expect(screen.getByTestId('add-dns-record-button')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('add-dns-record-button'));
    expect(screen.getByTestId('dns-record-form')).toBeInTheDocument();
    expect(screen.getByTestId('dns-type-select')).toBeInTheDocument();
    expect(screen.getByTestId('dns-value-input')).toBeInTheDocument();
  });

  it('shows delete button per record', async () => {
    setupMockApi();
    render(<DomainDetail />, { wrapper: createWrapper() });
    await switchToDnsTab();

    await waitFor(() => {
      expect(screen.getByTestId('delete-dns-rec-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('delete-dns-rec-2')).toBeInTheDocument();
  });

  it('shows confirm/cancel on delete click', async () => {
    setupMockApi();
    const user = userEvent.setup();
    render(<DomainDetail />, { wrapper: createWrapper() });
    await switchToDnsTab();

    await waitFor(() => {
      expect(screen.getByTestId('delete-dns-rec-1')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('delete-dns-rec-1'));
    expect(screen.getByTestId('confirm-delete-dns-rec-1')).toBeInTheDocument();
  });
});

// Hosting Settings and Protected Directories test suites removed —
// those tabs were moved to the per-route RouteDetail page.
