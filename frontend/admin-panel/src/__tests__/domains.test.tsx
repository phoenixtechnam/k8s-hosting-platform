import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Domains from '../pages/Domains';
import CreateDomainModal from '../components/CreateDomainModal';
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
  { id: 'client-1', companyName: 'Acme Corp', status: 'active' as const },
  { id: 'client-2', companyName: 'Beta Inc', status: 'active' as const },
];

const MOCK_DOMAINS = [
  {
    id: 'domain-1',
    clientId: 'client-1',
    domainName: 'example.com',
    status: 'active' as const,
    dnsMode: 'cname',
    sslAutoRenew: 1,
    createdAt: '2026-01-10T00:00:00Z',
  },
  {
    id: 'domain-2',
    clientId: 'client-1',
    domainName: 'test.org',
    status: 'pending' as const,
    dnsMode: 'primary',
    sslAutoRenew: 0,
    createdAt: '2026-02-15T00:00:00Z',
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

function setupMockApi() {
  mockApiFetch.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/clients') && !url.includes('/domains')) {
      return Promise.resolve({
        data: MOCK_CLIENTS,
        pagination: { total_count: 2, cursor: null, has_more: false, page_size: 200 },
      });
    }
    if (typeof url === 'string' && url.includes('/domains')) {
      return Promise.resolve({
        data: MOCK_DOMAINS,
        pagination: { total_count: 2, cursor: null, has_more: false, page_size: 50 },
      });
    }
    return Promise.resolve({ data: [], pagination: { total_count: 0, cursor: null, has_more: false, page_size: 50 } });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Domains page', () => {
  it('renders with client selector', () => {
    render(<Domains />, { wrapper: createWrapper() });
    expect(screen.getByTestId('client-selector')).toBeInTheDocument();
    expect(screen.getByText('All Clients')).toBeInTheDocument();
  });

  it('shows all clients by default without a prompt to select', () => {
    render(<Domains />, { wrapper: createWrapper() });
    expect(screen.queryByTestId('select-client-prompt')).not.toBeInTheDocument();
  });

  it('disables add domain button when no client selected', () => {
    render(<Domains />, { wrapper: createWrapper() });
    expect(screen.getByTestId('add-domain-button')).toBeDisabled();
  });

  it('has a search input', () => {
    render(<Domains />, { wrapper: createWrapper() });
    expect(screen.getByTestId('domain-search')).toBeInTheDocument();
  });
});

describe('CreateDomainModal', () => {
  it('renders form fields when open', () => {
    const onClose = vi.fn();
    render(<CreateDomainModal open={true} onClose={onClose} clientId="client-1" />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('create-domain-modal')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Add Domain' })).toBeInTheDocument();
    expect(screen.getByTestId('domain-name-input')).toBeInTheDocument();
    expect(screen.getByTestId('dns-mode-select')).toBeInTheDocument();
  });

  it('is hidden when closed', () => {
    const onClose = vi.fn();
    render(<CreateDomainModal open={false} onClose={onClose} clientId="client-1" />, {
      wrapper: createWrapper(),
    });
    expect(screen.queryByTestId('create-domain-modal')).not.toBeInTheDocument();
  });

  it('has required domain name field', () => {
    const onClose = vi.fn();
    render(<CreateDomainModal open={true} onClose={onClose} clientId="client-1" />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('domain-name-input')).toBeRequired();
  });

  it('has required dns mode field', () => {
    const onClose = vi.fn();
    render(<CreateDomainModal open={true} onClose={onClose} clientId="client-1" />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('dns-mode-select')).toBeRequired();
  });

  it('defaults dns mode to cname', () => {
    const onClose = vi.fn();
    render(<CreateDomainModal open={true} onClose={onClose} clientId="client-1" />, {
      wrapper: createWrapper(),
    });
    const select = screen.getByTestId('dns-mode-select') as HTMLSelectElement;
    expect(select.value).toBe('cname');
  });

  it('has submit and cancel buttons', () => {
    const onClose = vi.fn();
    render(<CreateDomainModal open={true} onClose={onClose} clientId="client-1" />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('submit-domain-button')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });
});

describe('Domain row expansion', () => {
  async function selectClientAndWaitForDomains() {
    const user = userEvent.setup();
    setupMockApi();
    render(<Domains />, { wrapper: createWrapper() });

    // Wait for clients to load so the select has options
    await waitFor(() => {
      expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    });

    // Select a client to trigger domain loading
    await user.selectOptions(screen.getByTestId('client-selector'), 'client-1');

    // Wait for domain rows to appear
    await waitFor(() => {
      expect(screen.getByTestId('domain-row-domain-1')).toBeInTheDocument();
    });

    return user;
  }

  it('domain rows are clickable and show expanded detail', async () => {
    const user = await selectClientAndWaitForDomains();

    // Click the first domain row
    await user.click(screen.getByTestId('domain-row-domain-1'));

    // The detail section should appear
    await waitFor(() => {
      expect(screen.getByTestId('domain-detail-domain-1')).toBeInTheDocument();
    });
  });

  it('expanded view shows DNS mode, SSL, and PowerDNS notice', async () => {
    const user = await selectClientAndWaitForDomains();

    await user.click(screen.getByTestId('domain-row-domain-1'));

    await waitFor(() => {
      expect(screen.getByTestId('domain-detail-dns-mode')).toBeInTheDocument();
    });

    expect(screen.getByTestId('domain-detail-dns-mode')).toHaveTextContent('cname');
    expect(screen.getByTestId('domain-detail-ssl')).toHaveTextContent('Yes');
    expect(screen.getByTestId('domain-detail-dns-notice')).toHaveTextContent(
      'DNS records are managed via PowerDNS. Configure in the infrastructure project.',
    );
  });

  it('clicking an expanded row collapses it', async () => {
    const user = await selectClientAndWaitForDomains();

    // Expand
    await user.click(screen.getByTestId('domain-row-domain-1'));
    await waitFor(() => {
      expect(screen.getByTestId('domain-detail-domain-1')).toBeInTheDocument();
    });

    // Collapse
    await user.click(screen.getByTestId('domain-row-domain-1'));
    await waitFor(() => {
      expect(screen.queryByTestId('domain-detail-domain-1')).not.toBeInTheDocument();
    });
  });

  it('only one domain is expanded at a time', async () => {
    const user = await selectClientAndWaitForDomains();

    await waitFor(() => {
      expect(screen.getByTestId('domain-row-domain-2')).toBeInTheDocument();
    });

    // Expand first domain
    await user.click(screen.getByTestId('domain-row-domain-1'));
    await waitFor(() => {
      expect(screen.getByTestId('domain-detail-domain-1')).toBeInTheDocument();
    });

    // Expand second domain — first should collapse
    await user.click(screen.getByTestId('domain-row-domain-2'));
    await waitFor(() => {
      expect(screen.getByTestId('domain-detail-domain-2')).toBeInTheDocument();
      expect(screen.queryByTestId('domain-detail-domain-1')).not.toBeInTheDocument();
    });
  });
});
