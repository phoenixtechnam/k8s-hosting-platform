import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ClientDetail from '../pages/ClientDetail';
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

const MOCK_CLIENT = {
  data: {
    id: 'client-001',
    companyName: 'Acme Corp',
    companyEmail: 'admin@acme.com',
    contactEmail: 'support@acme.com',
    status: 'active' as const,
    planId: 'plan-001',
    regionId: 'region-001',
    kubernetesNamespace: 'acme-ns',
    createdAt: '2026-01-01T00:00:00Z',
    createdBy: 'admin',
  },
};

const MOCK_DOMAINS = {
  data: [
    { id: 'd1', clientId: 'client-001', domainName: 'acme.com', status: 'active', sslAutoRenew: 1, dnsMode: 'cname', createdAt: '2026-01-10T00:00:00Z' },
    { id: 'd2', clientId: 'client-001', domainName: 'shop.acme.com', status: 'pending', sslAutoRenew: 0, dnsMode: 'primary', createdAt: '2026-01-11T00:00:00Z' },
  ],
  pagination: { total_count: 2, cursor: null, has_more: false, page_size: 25 },
};

const MOCK_DATABASES = {
  data: [
    { id: 'db1', clientId: 'client-001', name: 'acme_prod', databaseType: 'mysql', username: 'acme_usr', status: 'active', port: 3306, sizeBytes: 1048576, createdAt: '2026-01-05T00:00:00Z', updatedAt: '2026-01-05T00:00:00Z' },
  ],
  pagination: { total_count: 1, cursor: null, has_more: false, page_size: 25 },
};

const MOCK_DEPLOYMENTS = {
  data: [
    { id: 'w1', clientId: 'client-001', name: 'web-app', catalogEntryId: 'entry-1', type: 'runtime', status: 'running', replicaCount: 2, cpuRequest: '500m', memoryRequest: '256Mi', installedVersion: null, targetVersion: null, domainName: null, createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' },
    { id: 'w2', clientId: 'client-001', name: 'worker', catalogEntryId: 'entry-2', type: 'runtime', status: 'stopped', replicaCount: 1, cpuRequest: '250m', memoryRequest: '128Mi', installedVersion: null, targetVersion: null, domainName: null, createdAt: '2026-02-05T00:00:00Z', updatedAt: '2026-02-05T00:00:00Z' },
    { id: 'w3', clientId: 'client-001', name: 'cron-runner', catalogEntryId: 'entry-1', type: 'service', status: 'pending', replicaCount: 1, cpuRequest: '100m', memoryRequest: '64Mi', installedVersion: null, targetVersion: null, domainName: null, createdAt: '2026-02-10T00:00:00Z', updatedAt: '2026-02-10T00:00:00Z' },
  ],
  pagination: { total_count: 3, cursor: null, has_more: false, page_size: 25 },
};

const MOCK_BACKUPS = {
  data: [
    { id: 'b1', clientId: 'client-001', backupType: 'auto', resourceType: 'database', resourceId: 'db1', storagePath: null, sizeBytes: 5242880, status: 'completed', completedAt: '2026-03-01T00:01:00Z', expiresAt: '2026-04-01T00:00:00Z', notes: null, createdAt: '2026-03-01T00:00:00Z' },
  ],
  pagination: { total_count: 1, cursor: null, has_more: false, page_size: 25 },
};

const MOCK_EMAIL_DOMAINS = { data: [] };
const MOCK_MAILBOXES = { data: [] };

function setupMockApi() {
  mockApiFetch.mockImplementation((path: string) => {
    if (path.includes('/deployments')) return Promise.resolve(MOCK_DEPLOYMENTS);
    if (path.includes('/databases')) return Promise.resolve(MOCK_DATABASES);
    if (path.includes('/backups')) return Promise.resolve(MOCK_BACKUPS);
    if (path.includes('/mailboxes')) return Promise.resolve(MOCK_MAILBOXES);
    if (path.includes('/email/domains')) return Promise.resolve(MOCK_EMAIL_DOMAINS);
    if (path.includes('/domains')) return Promise.resolve(MOCK_DOMAINS);
    if (path.includes('/metrics')) return Promise.resolve({ data: { clientId: 'client-001', cpu: { inUse: 0.02, reserved: 0.5, available: 2 }, memory: { inUse: 0.1, reserved: 0.5, available: 4 }, storage: { inUse: 0.001, reserved: 10, available: 50 }, lastUpdatedAt: new Date().toISOString() } });
    if (path.match(/\/clients\/client-001$/)) return Promise.resolve(MOCK_CLIENT);
    return Promise.resolve({ data: [] });
  });
}

function renderClientDetail() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/clients/client-001']}>
        <Routes>
          <Route path="clients/:id" element={<ClientDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ClientDetail resource tabs', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupMockApi();
  });

  it('renders all resource tabs', async () => {
    renderClientDetail();

    await waitFor(() => {
      expect(screen.getByTestId('resource-tabs')).toBeInTheDocument();
    });

    expect(screen.getByTestId('tab-domains')).toBeInTheDocument();
    expect(screen.getByTestId('tab-applications')).toBeInTheDocument();
    expect(screen.getByTestId('tab-deployments')).toBeInTheDocument();
    expect(screen.getByTestId('tab-email')).toBeInTheDocument();
    expect(screen.getByTestId('tab-backups')).toBeInTheDocument();
  });

  it('shows counts in tab labels', async () => {
    renderClientDetail();

    await waitFor(() => {
      expect(screen.getByTestId('tab-domains')).toHaveTextContent('Domains (2)');
    });
    expect(screen.getByTestId('tab-deployments')).toHaveTextContent('Deployments (3)');
    expect(screen.getByTestId('tab-backups')).toHaveTextContent('Backups (1)');
  });

  it('defaults to domains tab and shows domains table', async () => {
    renderClientDetail();

    await waitFor(() => {
      expect(screen.getByTestId('domains-table')).toBeInTheDocument();
    });
    expect(screen.getByText('acme.com')).toBeInTheDocument();
    expect(screen.getByText('shop.acme.com')).toBeInTheDocument();
  });

  it('switches to deployments tab on click', async () => {
    renderClientDetail();

    await waitFor(() => {
      expect(screen.getByTestId('tab-deployments')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('tab-deployments'));

    await waitFor(() => {
      expect(screen.getByTestId('deployments-table')).toBeInTheDocument();
    });
    expect(screen.getByText('web-app')).toBeInTheDocument();
  });

  it('switches to deployments tab on click and shows deployment data', async () => {
    renderClientDetail();

    await waitFor(() => {
      expect(screen.getByTestId('tab-deployments')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('tab-deployments'));

    await waitFor(() => {
      expect(screen.getByTestId('deployments-table')).toBeInTheDocument();
    });
    expect(screen.getByText('web-app')).toBeInTheDocument();
    expect(screen.getByText('worker')).toBeInTheDocument();
    expect(screen.getByText('cron-runner')).toBeInTheDocument();
  });

  it('switches to backups tab on click', async () => {
    renderClientDetail();

    await waitFor(() => {
      expect(screen.getByTestId('tab-backups')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('tab-backups'));

    await waitFor(() => {
      expect(screen.getByTestId('backups-table')).toBeInTheDocument();
    });
    expect(screen.getByText('database')).toBeInTheDocument();
  });

  it('still shows client account info alongside tabs', async () => {
    renderClientDetail();

    await waitFor(() => {
      expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    });
    expect(screen.getByText('Account Information')).toBeInTheDocument();
    expect(screen.getByTestId('resource-tabs')).toBeInTheDocument();
  });
});

describe('ClientDetail impersonation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('opens the impersonation tab at the URL configured in System Settings, not the build-time env', async () => {
    // /system-info returns an admin-chosen clientPanelUrl. The
    // "Login as Client" button must use THIS value, not the runtime-config
    // fallback. A trailing slash on the configured URL must be stripped
    // so we don't produce "https://x//login".
    mockApiFetch.mockImplementation((path: string, options?: { method?: string }) => {
      if (options?.method === 'POST' && path.includes('/impersonate/')) {
        return Promise.resolve({
          data: {
            token: 'imp-token-xyz',
            user: { id: 'user-999', email: 'admin@acme.com', role: 'client_admin' },
            impersonatedBy: 'super-admin',
          },
        });
      }
      if (path.includes('/system-info')) {
        return Promise.resolve({
          data: {
            platformName: 'Acme Host',
            supportEmail: null,
            supportUrl: null,
            adminPanelUrl: 'https://admin.acme.com',
            clientPanelUrl: 'https://my.acme.com/', // trailing slash on purpose
          },
        });
      }
      if (path.includes('/deployments')) return Promise.resolve(MOCK_DEPLOYMENTS);
      if (path.includes('/backups')) return Promise.resolve(MOCK_BACKUPS);
      if (path.includes('/mailboxes')) return Promise.resolve(MOCK_MAILBOXES);
      if (path.includes('/email/domains')) return Promise.resolve(MOCK_EMAIL_DOMAINS);
      if (path.includes('/domains')) return Promise.resolve(MOCK_DOMAINS);
      if (path.match(/\/clients\/client-001$/)) return Promise.resolve(MOCK_CLIENT);
      return Promise.resolve({ data: [] });
    });

    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    renderClientDetail();
    await waitFor(() => {
      expect(screen.getByTestId('impersonate-button')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('impersonate-button'));

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledTimes(1);
    });
    const openedUrl = openSpy.mock.calls[0][0] as string;
    // DB URL wins, trailing slash stripped, token + user encoded.
    expect(openedUrl).toMatch(/^https:\/\/my\.acme\.com\/login\?token=imp-token-xyz&user=/);
    expect(openedUrl).not.toContain('//login'); // double slash check
    openSpy.mockRestore();
  });
});
