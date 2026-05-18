import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import DomainDetail from '../pages/DomainDetail';
import { apiFetch } from '@/lib/api-client';

vi.mock('@/hooks/use-tenant-context', () => ({
  useTenantContext: vi.fn(() => ({ tenantId: 'c1', tenantName: 'Test Corp', isLoading: false })),
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

const _MOCK_CLIENT = { id: 'c1', name: 'Test Corp' };
const MOCK_DOMAIN = {
  id: 'd1', tenantId: 'c1', domainName: 'example.com', status: 'active',
  dnsMode: 'cname', sslAutoRenew: 1, createdAt: '2026-01-10T00:00:00Z',
};
const MOCK_DOMAIN_PRIMARY = {
  ...MOCK_DOMAIN,
  dnsMode: 'primary',
};
const MOCK_DNS = [
  { id: 'r1', domainId: 'd1', recordType: 'A', recordName: '@', recordValue: '1.2.3.4', ttl: 3600, priority: null, weight: null, port: null, updatedAt: '2026-01-10T00:00:00Z' },
];
// Hosting and Protected Directories mock data removed — tabs moved to RouteDetail.

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

const MOCK_DOMAIN_WITH_FRESH_CACHE = {
  ...MOCK_DOMAIN,
  verificationCacheAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(), // 5 min ago
  verificationCacheResult: { verified: true, checks: [] },
};

function setupMocks() {
  mockApiFetch.mockImplementation((url: string) => {
    if (url.includes('/delete-preview'))
      return Promise.resolve({ data: MOCK_DELETE_PREVIEW });
    if (url.includes('/platform/ingress-base-domain'))
      return Promise.resolve({ data: { ingressBaseDomain: 'ingress.platform.net' } });
    if (url.includes('/domains') && !url.includes('/dns-records'))
      return Promise.resolve({ data: [MOCK_DOMAIN], pagination: { total_count: 1, cursor: null, has_more: false, page_size: 50 } });
    if (url.includes('/dns-records')) return Promise.resolve({ data: MOCK_DNS });
    return Promise.resolve({ data: [] });
  });
}

beforeEach(() => vi.clearAllMocks());

describe('Client DomainDetail page', () => {
  it('renders domain name and tabs (CNAME mode hides DNS tab)', async () => {
    setupMocks();
    render(<DomainDetail />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('domain-name-heading')).toHaveTextContent('example.com'));
    expect(screen.getByTestId('tab-routing')).toBeInTheDocument();
    // DNS tab is hidden for CNAME mode domains
    expect(screen.queryByTestId('tab-dns')).not.toBeInTheDocument();
    expect(screen.getByTestId('tab-ssl')).toBeInTheDocument();
    // DNS mode badge should be visible
    expect(screen.getByTestId('domain-dns-mode-badge')).toHaveTextContent('CNAME Mode');
  });

  it('shows domain not found for invalid domain', async () => {
    mockApiFetch.mockImplementation((_url: string) => {
      return Promise.resolve({ data: [], pagination: { total_count: 0, cursor: null, has_more: false, page_size: 50 } });
    });
    render(<DomainDetail />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('domain-not-found')).toBeInTheDocument());
  });

  // 2026-05-18: read-only managed-webmail row on the Routing tab.
  // Renders only when the email_domain row for this domain has
  // webmailEnabled === 1; otherwise hidden.
  it('renders the managed-webmail row on the Routing tab when per-domain webmail is enabled', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/email/domains'))
        return Promise.resolve({
          data: [
            {
              id: 'ed1',
              domainId: 'd1',
              domainName: 'example.com',
              enabled: 1,
              webmailEnabled: 1,
              webmailStatus: 'ready',
              maxMailboxes: 0,
              maxQuotaMb: 0,
            },
          ],
        });
      if (url.includes('/platform/ingress-base-domain'))
        return Promise.resolve({ data: { ingressBaseDomain: 'ingress.platform.net' } });
      if (url.includes('/domains') && !url.includes('/dns-records'))
        return Promise.resolve({
          data: [MOCK_DOMAIN],
          pagination: { total_count: 1, cursor: null, has_more: false, page_size: 50 },
        });
      return Promise.resolve({ data: [] });
    });

    render(<DomainDetail />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('domain-name-heading')).toHaveTextContent('example.com'));

    const row = await screen.findByTestId('managed-webmail-row');
    expect(row).toBeInTheDocument();
    expect(screen.getByTestId('managed-webmail-hostname')).toHaveTextContent('webmail.example.com');
    expect(screen.getByTestId('managed-webmail-status')).toHaveTextContent('Ready');
  });

  it('hides the managed-webmail row when per-domain webmail is NOT enabled (post-2026-05-18 default)', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/email/domains'))
        return Promise.resolve({
          data: [
            {
              id: 'ed1',
              domainId: 'd1',
              domainName: 'example.com',
              enabled: 1,
              webmailEnabled: 0,
              maxMailboxes: 0,
              maxQuotaMb: 0,
            },
          ],
        });
      if (url.includes('/platform/ingress-base-domain'))
        return Promise.resolve({ data: { ingressBaseDomain: 'ingress.platform.net' } });
      if (url.includes('/domains') && !url.includes('/dns-records'))
        return Promise.resolve({
          data: [MOCK_DOMAIN],
          pagination: { total_count: 1, cursor: null, has_more: false, page_size: 50 },
        });
      return Promise.resolve({ data: [] });
    });

    render(<DomainDetail />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('routing-tab')).toBeInTheDocument());
    expect(screen.queryByTestId('managed-webmail-row')).not.toBeInTheDocument();
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

function setupMocksPrimary() {
  mockApiFetch.mockImplementation((url: string) => {
    if (url.includes('/delete-preview'))
      return Promise.resolve({ data: MOCK_DELETE_PREVIEW });
    if (url.includes('/domains') && !url.includes('/dns-records'))
      return Promise.resolve({ data: [MOCK_DOMAIN_PRIMARY], pagination: { total_count: 1, cursor: null, has_more: false, page_size: 50 } });
    if (url.includes('/dns-records')) return Promise.resolve({ data: MOCK_DNS });
    return Promise.resolve({ data: [] });
  });
}

describe('Client DNS tab', () => {
  const switchToDns = async () => {
    await waitFor(() => expect(screen.getByTestId('tab-dns')).toBeInTheDocument());
    await userEvent.setup().click(screen.getByTestId('tab-dns'));
  };

  it('renders DNS records (primary mode)', async () => {
    setupMocksPrimary();
    render(<DomainDetail />, { wrapper: createWrapper() });
    await switchToDns();
    await waitFor(() => expect(screen.getByTestId('dns-records-table')).toBeInTheDocument());
    expect(screen.getByText('1.2.3.4')).toBeInTheDocument();
  });

  it('shows add form on button click (primary mode)', async () => {
    setupMocksPrimary();
    const user = userEvent.setup();
    render(<DomainDetail />, { wrapper: createWrapper() });
    await switchToDns();
    await waitFor(() => expect(screen.getByTestId('add-dns-record-button')).toBeInTheDocument());
    await user.click(screen.getByTestId('add-dns-record-button'));
    expect(screen.getByTestId('dns-record-form')).toBeInTheDocument();
  });
});

// Hosting and Protected Directories test suites removed — tabs moved to RouteDetail.

// Auto-verify-on-mount was intentionally removed (see DomainDetail.tsx
// line 61–62): the cron re-verifies every 24h; per-page-mount auto-fire
// caused duplicate DNS calls + delayed page render on every visit.
// The "fresh cache skips verify" behaviour collapses to a no-op now —
// verify is operator-triggered or cron-only.
