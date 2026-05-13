import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import EmailManagement from '../pages/EmailManagement';
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

function setupMockApi(domains: unknown[] = [], relays: unknown[] = []) {
  // The EmailManagement page mounts a fleet of mail-admin cards
  // (MailDrCard, MailArchiveCard, MailSnapshotHealthCard, etc) which
  // call their own endpoints on mount. Each card's queryFn expects a
  // typed envelope; returning a bare `{data: []}` here makes the cards
  // crash inside their error boundaries, which then propagates up and
  // blanks out the entire page — including the email-domains table the
  // tests below want to find.
  //
  // The mock returns shape-correct empty defaults for each known card
  // endpoint. We don't care about the card's *content* in these tests;
  // we care that the page renders cleanly through to the domains table.
  mockApiFetch.mockImplementation((url: string) => {
    if (typeof url !== 'string') return Promise.resolve({ data: null });
    if (url.includes('/email/domains'))        return Promise.resolve({ data: domains });
    if (url.includes('/smtp-relays'))          return Promise.resolve({ data: relays });
    if (url.includes('/mail/placement'))       return Promise.resolve({ data: { primaryNode: 'node-a', secondaryNode: null, tertiaryNode: null, autoFailoverEnabled: false, failoverThresholdSeconds: 60, drState: 'healthy', candidateNodes: [], currentScheduledNode: 'node-a', deploymentReady: true } });
    if (url.includes('/mail/port-exposure'))   return Promise.resolve({ data: { mode: 'thisNodeOnly', haproxyReady: 0, haproxyDesired: 0 } });
    if (url.includes('/mail/archive-status'))  return Promise.resolve({ data: { last: null, current: null, backupTarget: { backupStoreId: null, backupStoreName: null, storageType: null }, scheduledArchivingAvailable: false, scheduledArchivingBlockedBy: null } });
    if (url.includes('/mail/archive-runs'))    return Promise.resolve({ data: { data: [], total: 0 } });
    if (url.includes('/mail/snapshot/health')) return Promise.resolve({ data: { state: 'never_run', lastRun: null, nextRun: null } });
    if (url.includes('/mail/snapshot/schedule')) return Promise.resolve({ data: { cron: null, enabled: false } });
    if (url.includes('/mail/snapshot/backup-target')) return Promise.resolve({ data: { backupStoreId: null, backupStoreName: null, storageType: null } });
    if (url.includes('/mail/snapshot'))        return Promise.resolve({ data: { running: false } });
    if (url.includes('/mail/pvc/storage'))     return Promise.resolve({ data: { pvcName: 'stalwart-rocksdb-data', storageClass: 'local-path', capacityBytes: 21474836480, requestedBytes: 21474836480, usedBytes: 0, freeBytes: 21474836480, expansionAllowed: false, lastResizedAt: null } });
    if (url.includes('/mail/blob-store'))      return Promise.resolve({ data: { type: 'local', config: {} } });
    if (url.includes('/mail/ssl-status'))      return Promise.resolve({ data: { listeners: [] } });
    if (url.includes('/mail/metrics'))         return Promise.resolve({ data: { totalMailboxes: 0, dkimConfigured: 0 } });
    if (url.includes('/admin/mail/'))          return Promise.resolve({ data: null });
    return Promise.resolve({ data: [] });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EmailManagement page', () => {
  it('renders page heading', () => {
    setupMockApi();
    render(<EmailManagement />, { wrapper: createWrapper() });
    expect(screen.getByTestId('email-mgmt-heading')).toBeInTheDocument();
    expect(screen.getByText('Email Management')).toBeInTheDocument();
  });

  it('shows stat cards', async () => {
    setupMockApi();
    render(<EmailManagement />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText('Total Mailboxes')).toBeInTheDocument();
    });
    expect(screen.getByText('DKIM Configured')).toBeInTheDocument();
    expect(screen.getByText('Mail Server')).toBeInTheDocument();
    expect(screen.getByText('Stalwart')).toBeInTheDocument();
  });

  it('shows tab bar with domains and relays tabs', () => {
    setupMockApi();
    render(<EmailManagement />, { wrapper: createWrapper() });
    expect(screen.getByTestId('tab-domains')).toBeInTheDocument();
    expect(screen.getByTestId('tab-relays')).toBeInTheDocument();
  });

  it('shows email domains table by default', async () => {
    setupMockApi();
    render(<EmailManagement />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('email-domains-table')).toBeInTheDocument();
    });
  });

  it('shows empty state when no domains exist', async () => {
    setupMockApi();
    render(<EmailManagement />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText('No email-enabled domains yet.')).toBeInTheDocument();
    });
  });

  it('switches to SMTP relays tab', async () => {
    setupMockApi([], []);
    render(<EmailManagement />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('tab-relays'));
    await waitFor(() => {
      expect(screen.getByTestId('add-relay-button')).toBeInTheDocument();
    });
  });

  it('renders domain rows when data is returned', async () => {
    setupMockApi([
      {
        id: 'ed-1',
        domainName: 'example.com',
        mailboxCount: 5,
        mxProvisioned: 1,
        spfProvisioned: 1,
        dkimProvisioned: 1,
        dmarcProvisioned: 0,
        spamThresholdJunk: '5.0',
        enabled: 1,
      },
    ]);
    render(<EmailManagement />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText('example.com')).toBeInTheDocument();
    });
    // mailboxCount 5 appears in both the table cell and stat card; just verify domain row rendered
    expect(screen.getByText('Junk: 5.0')).toBeInTheDocument();
  });
});
