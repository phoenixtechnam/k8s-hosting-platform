import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import DomainDetail from '../pages/DomainDetail';
import { apiFetch } from '@/lib/api-client';

vi.mock('@/hooks/use-client-context', () => ({
  useClientContext: vi.fn(() => ({ clientId: 'c1', clientName: 'Test Corp', isLoading: false })),
}));

vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

const mockApiFetch = vi.mocked(apiFetch);

const _MOCK_CLIENT = { id: 'c1', companyName: 'Test Corp' };
const MOCK_DOMAIN = {
  id: 'd1', clientId: 'c1', domainName: 'example.com', status: 'active',
  dnsMode: 'cname', sslAutoRenew: 1, createdAt: '2026-01-10T00:00:00Z',
};
const MOCK_DNS = [
  { id: 'r1', domainId: 'd1', recordType: 'A', recordName: '@', recordValue: '1.2.3.4', ttl: 3600, priority: null, weight: null, port: null, updatedAt: '2026-01-10T00:00:00Z' },
];
const MOCK_HOSTING = {
  id: 'h1', domainId: 'd1', redirectWww: false, redirectHttps: true,
  forwardExternal: null, webrootPath: '/var/www/html', hostingEnabled: true,
  createdAt: '2026-01-10T00:00:00Z', updatedAt: '2026-01-10T00:00:00Z',
};
const MOCK_DIRS = [
  { id: 'dir1', domainId: 'd1', path: '/secret', realm: 'Private', createdAt: '2026-01-10T00:00:00Z', updatedAt: '2026-01-10T00:00:00Z' },
];
const MOCK_USERS = [
  { id: 'u1', directoryId: 'dir1', username: 'alice', enabled: true, createdAt: '2026-01-10T00:00:00Z' },
];

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/domains/d1']}>
          <Routes>
            <Route path="/domains/:domainId" element={children} />
            <Route path="/domains" element={<div>Domains List</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

const MOCK_DELETE_PREVIEW = {
  domainName: 'example.com',
  dnsRecords: [
    { id: 'r1', type: 'A', name: '@' },
    { id: 'r2', type: 'MX', name: null },
  ],
  emailDomain: {
    id: 'ed1',
    webmailEnabled: true,
    mailboxes: [
      { id: 'mb1', fullAddress: 'alice@example.com' },
      { id: 'mb2', fullAddress: 'bob@example.com' },
    ],
    aliases: [{ id: 'a1', sourceAddress: 'info@example.com' }],
  },
  ingressRoutes: [{ id: 'ir1', hostname: 'example.com' }],
  webmailIngressHostname: 'webmail.example.com',
};

function setupMocks() {
  mockApiFetch.mockImplementation((url: string) => {
    if (url.includes('/delete-preview'))
      return Promise.resolve({ data: MOCK_DELETE_PREVIEW });
    if (url.includes('/domains') && !url.includes('/dns-records') && !url.includes('/hosting-settings') && !url.includes('/protected-directories'))
      return Promise.resolve({ data: [MOCK_DOMAIN], pagination: { total_count: 1, cursor: null, has_more: false, page_size: 50 } });
    if (url.includes('/dns-records')) return Promise.resolve({ data: MOCK_DNS });
    if (url.includes('/hosting-settings')) return Promise.resolve({ data: MOCK_HOSTING });
    if (url.includes('/protected-directories') && url.includes('/users')) return Promise.resolve({ data: MOCK_USERS });
    if (url.includes('/protected-directories')) return Promise.resolve({ data: MOCK_DIRS });
    return Promise.resolve({ data: [] });
  });
}

beforeEach(() => vi.clearAllMocks());

describe('Client DomainDetail page', () => {
  it('renders domain name and tabs', async () => {
    setupMocks();
    render(<DomainDetail />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('domain-name-heading')).toHaveTextContent('example.com'));
    expect(screen.getByTestId('tab-dns')).toBeInTheDocument();
    expect(screen.getByTestId('tab-hosting')).toBeInTheDocument();
    expect(screen.getByTestId('tab-protected')).toBeInTheDocument();
  });

  it('shows domain not found for invalid domain', async () => {
    mockApiFetch.mockImplementation((_url: string) => {
      return Promise.resolve({ data: [], pagination: { total_count: 0, cursor: null, has_more: false, page_size: 50 } });
    });
    render(<DomainDetail />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('domain-not-found')).toBeInTheDocument());
  });

  it('delete modal renders the cascade preview with DNS records, mailboxes, aliases, ingress routes and webmail hostname', async () => {
    setupMocks();
    const user = userEvent.setup();
    render(<DomainDetail />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('domain-name-heading')).toHaveTextContent('example.com'));

    await user.click(screen.getByTestId('delete-domain-button'));

    // The modal + preview list should render once the mocked preview
    // resolves. Each section is marked with a distinct testid.
    await waitFor(() => expect(screen.getByTestId('delete-preview-list')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('delete-preview-dns')).toBeInTheDocument());
    expect(screen.getByTestId('delete-preview-email')).toBeInTheDocument();
    expect(screen.getByTestId('delete-preview-routes')).toBeInTheDocument();
    expect(screen.getByTestId('delete-preview-webmail')).toBeInTheDocument();
    // Spot-check a few visible values from the mocked preview
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('info@example.com')).toBeInTheDocument();
    expect(screen.getByText('webmail.example.com')).toBeInTheDocument();
    expect(screen.getByText(/2 DNS record\(s\)/)).toBeInTheDocument();
  });
});

describe('Client DNS tab', () => {
  const switchToDns = async () => {
    await waitFor(() => expect(screen.getByTestId('tab-dns')).toBeInTheDocument());
    await userEvent.setup().click(screen.getByTestId('tab-dns'));
  };

  it('renders DNS records', async () => {
    setupMocks();
    render(<DomainDetail />, { wrapper: createWrapper() });
    await switchToDns();
    await waitFor(() => expect(screen.getByTestId('dns-records-table')).toBeInTheDocument());
    expect(screen.getByText('1.2.3.4')).toBeInTheDocument();
  });

  it('shows add form on button click', async () => {
    setupMocks();
    const user = userEvent.setup();
    render(<DomainDetail />, { wrapper: createWrapper() });
    await switchToDns();
    await waitFor(() => expect(screen.getByTestId('add-dns-record-button')).toBeInTheDocument());
    await user.click(screen.getByTestId('add-dns-record-button'));
    expect(screen.getByTestId('dns-record-form')).toBeInTheDocument();
  });
});

describe('Client Hosting tab', () => {
  it('renders hosting settings form', async () => {
    setupMocks();
    const user = userEvent.setup();
    render(<DomainDetail />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('tab-hosting')).toBeInTheDocument());
    await user.click(screen.getByTestId('tab-hosting'));
    await waitFor(() => expect(screen.getByTestId('hosting-settings-form')).toBeInTheDocument());
    expect(screen.getByTestId('redirect-https-toggle')).toBeChecked();
    expect(screen.getByTestId('webroot-path-input')).toHaveValue('/var/www/html');
  });

  it('save button disabled until change', async () => {
    setupMocks();
    const user = userEvent.setup();
    render(<DomainDetail />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('tab-hosting')).toBeInTheDocument());
    await user.click(screen.getByTestId('tab-hosting'));
    await waitFor(() => expect(screen.getByTestId('save-hosting-settings')).toBeDisabled());
    await user.click(screen.getByTestId('redirect-www-toggle'));
    expect(screen.getByTestId('save-hosting-settings')).toBeEnabled();
  });
});

describe('Client Protected dirs tab', () => {
  it('renders protected directories', async () => {
    setupMocks();
    const user = userEvent.setup();
    render(<DomainDetail />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('tab-protected')).toBeInTheDocument());
    await user.click(screen.getByTestId('tab-protected'));
    await waitFor(() => expect(screen.getByText('/secret')).toBeInTheDocument());
  });

  it('expanding dir shows users', async () => {
    setupMocks();
    const user = userEvent.setup();
    render(<DomainDetail />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('tab-protected')).toBeInTheDocument());
    await user.click(screen.getByTestId('tab-protected'));
    await waitFor(() => expect(screen.getByTestId('dir-row-dir1')).toBeInTheDocument());
    await user.click(screen.getByTestId('dir-row-dir1'));
    await waitFor(() => expect(screen.getByTestId('dir-users-dir1')).toBeInTheDocument());
    expect(screen.getByText('alice')).toBeInTheDocument();
  });
});
