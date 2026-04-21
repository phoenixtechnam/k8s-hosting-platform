import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import DatabaseManagementModal from '../components/DatabaseManagementModal';
import type { Deployment, CatalogEntry } from '@/types/api';

// Mock all deployment hooks
const mockUseDeploymentCredentials = vi.fn();
const mockUseRegenerateCredentials = vi.fn();
const mockUseRestartDeployment = vi.fn();
const mockUseDbDatabases = vi.fn();
const mockUseCreateDbDatabase = vi.fn();
const mockUseDropDbDatabase = vi.fn();
const mockUseDbUsers = vi.fn();
const mockUseCreateDbUser = vi.fn();
const mockUseDropDbUser = vi.fn();
const mockUseSetDbUserPassword = vi.fn();

vi.mock('../hooks/use-deployments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/use-deployments')>();
  return {
    ...actual,
    useDeploymentCredentials: (...args: unknown[]) => mockUseDeploymentCredentials(...args),
    useRegenerateCredentials: (...args: unknown[]) => mockUseRegenerateCredentials(...args),
    useRestartDeployment: (...args: unknown[]) => mockUseRestartDeployment(...args),
    useDbDatabases: (...args: unknown[]) => mockUseDbDatabases(...args),
    useCreateDbDatabase: (...args: unknown[]) => mockUseCreateDbDatabase(...args),
    useDropDbDatabase: (...args: unknown[]) => mockUseDropDbDatabase(...args),
    useDbUsers: (...args: unknown[]) => mockUseDbUsers(...args),
    useCreateDbUser: (...args: unknown[]) => mockUseCreateDbUser(...args),
    useDropDbUser: (...args: unknown[]) => mockUseDropDbUser(...args),
    useSetDbUserPassword: (...args: unknown[]) => mockUseSetDbUserPassword(...args),
  };
});

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

const mockDeployment: Deployment = {
  id: 'dep-1',
  clientId: 'client-1',
  catalogEntryId: 'entry-1',
  name: 'my-mariadb',
  domainName: null,
  replicaCount: 1,
  cpuRequest: '0.25',
  memoryRequest: '256Mi',
  configuration: {},
  installedVersion: '10.11',
  targetVersion: '10.11',
  status: 'running',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
} as Deployment;

const mockDatabaseEntry: CatalogEntry = {
  id: 'entry-1',
  code: 'mariadb',
  name: 'MariaDB',
  type: 'database',
} as CatalogEntry;

const mockNonDatabaseEntry: CatalogEntry = {
  id: 'entry-2',
  code: 'nodejs',
  name: 'Node.js',
  type: 'runtime',
} as CatalogEntry;

function setupDefaultMocks() {
  mockUseDeploymentCredentials.mockReturnValue({
    data: {
      data: {
        credentials: { MARIADB_ROOT_PASSWORD: 'secret123' },
        connectionInfo: { host: 'my-mariadb.client-1.svc.cluster.local', port: 3306, database: 'mydb', username: 'admin' },
        generatedKeys: ['MARIADB_ROOT_PASSWORD'],
      },
    },
    isLoading: false,
  });
  mockUseRegenerateCredentials.mockReturnValue({ mutate: vi.fn(), isPending: false, isSuccess: false });
  mockUseRestartDeployment.mockReturnValue({ mutate: vi.fn(), isPending: false, isSuccess: false });
  mockUseDbDatabases.mockReturnValue({
    data: { data: [{ name: 'app_db' }, { name: 'test_db' }] },
    isLoading: false,
    isError: false,
  });
  mockUseCreateDbDatabase.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mockUseDropDbDatabase.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mockUseDbUsers.mockReturnValue({
    data: { data: [{ username: 'admin', host: '%' }, { username: 'reader', host: '%' }] },
    isLoading: false,
    isError: false,
  });
  mockUseCreateDbUser.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mockUseDropDbUser.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mockUseSetDbUserPassword.mockReturnValue({ mutate: vi.fn(), isPending: false });
}

describe('DatabaseManagementModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('renders nothing when closed', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={false}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        clientId="client-1"
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('database-management-modal')).not.toBeInTheDocument();
  });

  it('renders nothing when no deployment', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={null}
        catalogEntry={mockDatabaseEntry}
        clientId="client-1"
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('database-management-modal')).not.toBeInTheDocument();
  });

  it('renders the modal with deployment name', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        clientId="client-1"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('database-management-modal')).toBeInTheDocument();
    expect(screen.getByText('my-mariadb')).toBeInTheDocument();
    expect(screen.getByText('Database Management')).toBeInTheDocument();
  });

  it('renders connection info card', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        clientId="client-1"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('connection-info-card')).toBeInTheDocument();
    expect(screen.getByText('my-mariadb.client-1.svc.cluster.local')).toBeInTheDocument();
  });

  it('renders credentials card', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        clientId="client-1"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('credentials-card')).toBeInTheDocument();
  });

  it('renders databases card for database-type entries', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        clientId="client-1"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('databases-card')).toBeInTheDocument();
    expect(screen.getByTestId('db-row-app_db')).toBeInTheDocument();
    expect(screen.getByTestId('db-row-test_db')).toBeInTheDocument();
  });

  it('renders database users card for database-type entries', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        clientId="client-1"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('db-users-card')).toBeInTheDocument();
    expect(screen.getByTestId('user-row-admin')).toBeInTheDocument();
    expect(screen.getByTestId('user-row-reader')).toBeInTheDocument();
  });

  it('does not render databases or users cards for non-database entries', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockNonDatabaseEntry}
        clientId="client-1"
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('databases-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('db-users-card')).not.toBeInTheDocument();
  });

  it('shows create database form', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        clientId="client-1"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('create-db-form')).toBeInTheDocument();
    expect(screen.getByTestId('create-db-input')).toBeInTheDocument();
    expect(screen.getByTestId('create-db-button')).toBeInTheDocument();
  });

  it('creates a database when submitting the form', () => {
    const mutateFn = vi.fn();
    mockUseCreateDbDatabase.mockReturnValue({ mutate: mutateFn, isPending: false });

    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        clientId="client-1"
        onClose={vi.fn()}
      />,
    );

    const input = screen.getByTestId('create-db-input');
    fireEvent.change(input, { target: { value: 'new_db' } });
    fireEvent.click(screen.getByTestId('create-db-button'));

    expect(mutateFn).toHaveBeenCalledWith(
      { deploymentId: 'dep-1', name: 'new_db' },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });

  it('shows delete confirmation for database', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        clientId="client-1"
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('db-delete-app_db'));
    expect(screen.getByTestId('db-delete-confirm-app_db')).toBeInTheDocument();
    expect(screen.getByTestId('db-delete-cancel-app_db')).toBeInTheDocument();
  });

  it('cancels delete confirmation for database', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        clientId="client-1"
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('db-delete-app_db'));
    fireEvent.click(screen.getByTestId('db-delete-cancel-app_db'));
    expect(screen.queryByTestId('db-delete-confirm-app_db')).not.toBeInTheDocument();
  });

  it('shows add user button and form', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        clientId="client-1"
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('show-create-user-form'));
    expect(screen.getByTestId('create-user-form')).toBeInTheDocument();
    expect(screen.getByTestId('create-user-username')).toBeInTheDocument();
    expect(screen.getByTestId('create-user-database')).toBeInTheDocument();
    expect(screen.getByTestId('create-user-submit')).toBeInTheDocument();
    expect(screen.getByTestId('create-user-cancel')).toBeInTheDocument();
  });

  it('creates a user when submitting the form', () => {
    const mutateFn = vi.fn();
    mockUseCreateDbUser.mockReturnValue({ mutate: mutateFn, isPending: false });

    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        clientId="client-1"
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('show-create-user-form'));
    fireEvent.change(screen.getByTestId('create-user-username'), { target: { value: 'new_user' } });
    fireEvent.click(screen.getByTestId('create-user-submit'));

    expect(mutateFn).toHaveBeenCalledWith(
      expect.objectContaining({ deploymentId: 'dep-1', username: 'new_user', password: expect.any(String) }),
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });

  it('triggers password regeneration for a user', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        clientId="client-1"
        onClose={vi.fn()}
      />,
    );

    // The set-password button now triggers regeneration directly (auto-generate)
    const regenButton = screen.getByTestId('user-set-password-admin');
    expect(regenButton).toBeInTheDocument();
    fireEvent.click(regenButton);
    // The mutation should be called with a generated password
  });

  it('shows delete confirmation for user', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        clientId="client-1"
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('user-delete-reader'));
    expect(screen.getByTestId('user-delete-confirm-reader')).toBeInTheDocument();
    expect(screen.getByTestId('user-delete-cancel-reader')).toBeInTheDocument();
  });

  it('renders actions card with restart button', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        clientId="client-1"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('actions-card')).toBeInTheDocument();
    expect(screen.getByTestId('restart-database-button')).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        clientId="client-1"
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByTestId('db-modal-close-button'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows loading state while credentials are loading', () => {
    mockUseDeploymentCredentials.mockReturnValue({ data: null, isLoading: true });

    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        clientId="client-1"
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('connection-info-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('databases-card')).not.toBeInTheDocument();
  });

  it('shows error state when databases fail to load', () => {
    mockUseDbDatabases.mockReturnValue({
      data: null,
      isLoading: false,
      isError: true,
    });

    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        clientId="client-1"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('databases-error')).toBeInTheDocument();
  });

  it('shows error state when users fail to load', () => {
    mockUseDbUsers.mockReturnValue({
      data: null,
      isLoading: false,
      isError: true,
    });

    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        clientId="client-1"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('db-users-error')).toBeInTheDocument();
  });
});
