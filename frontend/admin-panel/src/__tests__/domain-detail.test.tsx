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

const MOCK_HOSTING_SETTINGS = {
  id: 'hs-1',
  domainId: 'domain-1',
  redirectWww: false,
  redirectHttps: true,
  forwardExternal: null,
  webrootPath: '/var/www/html',
  hostingEnabled: true,
  createdAt: '2026-01-10T00:00:00Z',
  updatedAt: '2026-01-10T00:00:00Z',
};

const MOCK_PROTECTED_DIRS = [
  {
    id: 'dir-1',
    domainId: 'domain-1',
    path: '/admin',
    realm: 'Admin Area',
    createdAt: '2026-01-10T00:00:00Z',
    updatedAt: '2026-01-10T00:00:00Z',
  },
];

const MOCK_DIR_USERS = [
  {
    id: 'user-1',
    directoryId: 'dir-1',
    username: 'admin',
    enabled: true,
    createdAt: '2026-01-10T00:00:00Z',
  },
];

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
    if (typeof url === 'string' && url.includes('/domains') && !url.includes('/dns-records') && !url.includes('/hosting-settings') && !url.includes('/protected-directories')) {
      return Promise.resolve({
        data: [MOCK_DOMAIN],
        pagination: { total_count: 1, cursor: null, has_more: false, page_size: 100 },
      });
    }
    if (typeof url === 'string' && url.includes('/dns-records')) {
      return Promise.resolve({ data: MOCK_DNS_RECORDS });
    }
    if (typeof url === 'string' && url.includes('/hosting-settings')) {
      return Promise.resolve({ data: MOCK_HOSTING_SETTINGS });
    }
    if (typeof url === 'string' && url.includes('/protected-directories') && url.includes('/users')) {
      return Promise.resolve({ data: MOCK_DIR_USERS });
    }
    if (typeof url === 'string' && url.includes('/protected-directories')) {
      return Promise.resolve({ data: MOCK_PROTECTED_DIRS });
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

  it('shows 3 tabs: DNS Records, Hosting Settings, Protected Directories', async () => {
    setupMockApi();
    render(<DomainDetail />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('tab-dns')).toBeInTheDocument();
    });
    expect(screen.getByTestId('tab-hosting')).toBeInTheDocument();
    expect(screen.getByTestId('tab-protected')).toBeInTheDocument();
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
  it('renders DNS records table', async () => {
    setupMockApi();
    render(<DomainDetail />, { wrapper: createWrapper() });

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

    await waitFor(() => {
      expect(screen.getByTestId('delete-dns-rec-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('delete-dns-rec-2')).toBeInTheDocument();
  });

  it('shows confirm/cancel on delete click', async () => {
    setupMockApi();
    const user = userEvent.setup();
    render(<DomainDetail />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('delete-dns-rec-1')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('delete-dns-rec-1'));
    expect(screen.getByTestId('confirm-delete-dns-rec-1')).toBeInTheDocument();
  });
});

describe('Hosting Settings tab', () => {
  it('renders hosting settings form', async () => {
    setupMockApi();
    const user = userEvent.setup();
    render(<DomainDetail />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('tab-hosting')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('tab-hosting'));

    await waitFor(() => {
      expect(screen.getByTestId('hosting-settings-form')).toBeInTheDocument();
    });

    expect(screen.getByTestId('redirect-www-toggle')).not.toBeChecked();
    expect(screen.getByTestId('redirect-https-toggle')).toBeChecked();
    expect(screen.getByTestId('hosting-enabled-toggle')).toBeChecked();
    expect(screen.getByTestId('webroot-path-input')).toHaveValue('/var/www/html');
  });

  it('save button is disabled when nothing changed', async () => {
    setupMockApi();
    const user = userEvent.setup();
    render(<DomainDetail />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('tab-hosting')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('tab-hosting'));

    await waitFor(() => {
      expect(screen.getByTestId('save-hosting-settings')).toBeInTheDocument();
    });

    expect(screen.getByTestId('save-hosting-settings')).toBeDisabled();
  });

  it('save button enables after change', async () => {
    setupMockApi();
    const user = userEvent.setup();
    render(<DomainDetail />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('tab-hosting')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('tab-hosting'));

    await waitFor(() => {
      expect(screen.getByTestId('redirect-www-toggle')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('redirect-www-toggle'));
    expect(screen.getByTestId('save-hosting-settings')).toBeEnabled();
  });
});

describe('Protected Directories tab', () => {
  it('renders protected directories list', async () => {
    setupMockApi();
    const user = userEvent.setup();
    render(<DomainDetail />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('tab-protected')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('tab-protected'));

    await waitFor(() => {
      expect(screen.getByTestId('protected-dirs-section')).toBeInTheDocument();
    });
    expect(screen.getByText('/admin')).toBeInTheDocument();
    expect(screen.getByText('(Admin Area)')).toBeInTheDocument();
  });

  it('has add directory button that shows form', async () => {
    setupMockApi();
    const user = userEvent.setup();
    render(<DomainDetail />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('tab-protected')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('tab-protected'));

    await waitFor(() => {
      expect(screen.getByTestId('add-protected-dir-button')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('add-protected-dir-button'));
    expect(screen.getByTestId('create-dir-form')).toBeInTheDocument();
    expect(screen.getByTestId('dir-path-input')).toBeInTheDocument();
  });

  it('expanding a directory shows users panel', async () => {
    setupMockApi();
    const user = userEvent.setup();
    render(<DomainDetail />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('tab-protected')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('tab-protected'));

    await waitFor(() => {
      expect(screen.getByTestId('dir-row-dir-1')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('dir-row-dir-1'));

    await waitFor(() => {
      expect(screen.getByTestId('dir-users-dir-1')).toBeInTheDocument();
    });
    expect(screen.getByText('admin')).toBeInTheDocument();
  });

  it('shows add user button in expanded directory', async () => {
    setupMockApi();
    const user = userEvent.setup();
    render(<DomainDetail />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('tab-protected')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('tab-protected'));

    await waitFor(() => {
      expect(screen.getByTestId('dir-row-dir-1')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('dir-row-dir-1'));

    await waitFor(() => {
      expect(screen.getByTestId('add-dir-user-dir-1')).toBeInTheDocument();
    });
  });
});
