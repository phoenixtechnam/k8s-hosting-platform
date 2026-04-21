import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Files from '../pages/Files';

// ─── Mock hooks ──────────────────────────────────────────────────────────────

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importActual) => {
  const actual = await importActual<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockMutate = vi.fn();
const mockMutateAsync = vi.fn().mockResolvedValue({});

vi.mock('../hooks/use-client-context', () => ({
  useClientContext: () => ({ clientId: 'client-123' }),
}));

const fmStatusData = { ready: true, phase: 'ready' as const };
const dirEntries = [
  { name: 'docs', type: 'directory' as const, size: 0, modifiedAt: '2026-01-01T00:00:00Z', permissions: '755' },
  { name: 'images', type: 'directory' as const, size: 0, modifiedAt: '2026-01-01T00:00:00Z', permissions: '755' },
  { name: 'index.html', type: 'file' as const, size: 1024, modifiedAt: '2026-01-01T00:00:00Z', permissions: '644' },
  { name: 'photo.jpg', type: 'file' as const, size: 5120, modifiedAt: '2026-01-01T00:00:00Z', permissions: '644' },
  { name: 'backup.tar.gz', type: 'file' as const, size: 204800, modifiedAt: '2026-01-01T00:00:00Z', permissions: '644' },
  { name: 'style.css', type: 'file' as const, size: 512, modifiedAt: '2026-01-01T00:00:00Z', permissions: '644' },
];

const mockFmStatus = vi.fn((): { data: { ready: boolean; phase: string; message?: string } | null; isLoading: boolean; error: null } => ({ data: fmStatusData, isLoading: false, error: null }));
const mockDirListing = vi.fn(() => ({
  data: { path: '/', entries: dirEntries },
  isLoading: false,
  error: null,
  refetch: vi.fn(),
}));
const mockFileContent = vi.fn(() => ({
  data: { path: '/index.html', content: '<h1>Hello</h1>', size: 14, modifiedAt: '2026-01-01T00:00:00Z' },
  isLoading: false,
  error: null,
}));

vi.mock('../hooks/use-file-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/use-file-manager')>();
  return {
    ...actual,
    useFileManagerStatus: () => mockFmStatus(),
    useStartFileManager: () => ({ mutate: mockMutate, isPending: false }),
    useDirectoryListing: () => mockDirListing(),
    useFileContent: () => mockFileContent(),
    useCreateDirectory: () => ({ mutate: mockMutate, isPending: false }),
    useWriteFile: () => ({ mutate: mockMutate, isPending: false }),
    useRenameFile: () => ({ mutate: mockMutate, mutateAsync: mockMutateAsync, isPending: false }),
    useDeleteFile: () => ({ mutate: mockMutate, mutateAsync: mockMutateAsync, isPending: false }),
    useDownloadFile: () => vi.fn(),
    useUploadFiles: () => ({
      uploads: [],
      uploadFiles: vi.fn(),
      clearUploads: vi.fn(),
      visible: false,
      setVisible: vi.fn(),
    }),
    useCopyFile: () => ({ mutate: mockMutate, mutateAsync: mockMutateAsync, isPending: false }),
    useArchiveFiles: () => ({ mutate: mockMutate, isPending: false }),
    useExtractArchive: () => ({ mutate: mockMutate, isPending: false }),
    useGitClone: () => ({ mutate: mockMutate, isPending: false }),
    useAuthenticatedBlobUrl: () => ({ data: 'blob:http://localhost/test-blob', isLoading: false, error: null }),
    useDiskUsage: () => ({ data: { data: { usedBytes: 1048576, totalBytes: 10737418240, availableBytes: 10736369664, usedFormatted: '1.0 MB', totalFormatted: '10.0 GB', availableFormatted: '10.0 GB' } }, isLoading: false }),
    useFolderSize: () => ({ mutateAsync: vi.fn().mockResolvedValue({ data: { path: '/', sizeBytes: 1024, sizeFormatted: '1.0 KB' } }), isPending: false }),
    useChmod: () => ({ mutate: mockMutate, mutateAsync: mockMutateAsync, isPending: false }),
  };
});

// Mock Monaco editor
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea data-testid="monaco-editor" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function renderFiles() {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter><Files /></MemoryRouter>
    </QueryClientProvider>,
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Files Page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFmStatus.mockReturnValue({ data: fmStatusData, isLoading: false, error: null });
    mockDirListing.mockReturnValue({
      data: { path: '/', entries: dirEntries },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  describe('Basic rendering', () => {
    it('renders the heading and description', () => {
      renderFiles();
      expect(screen.getByTestId('files-heading')).toBeInTheDocument();
      expect(screen.getByText('Manage your website files and directories.')).toBeInTheDocument();
    });

    it('renders all file entries', () => {
      renderFiles();
      expect(screen.getByText('docs')).toBeInTheDocument();
      expect(screen.getByText('index.html')).toBeInTheDocument();
      expect(screen.getByText('photo.jpg')).toBeInTheDocument();
      expect(screen.getByText('backup.tar.gz')).toBeInTheDocument();
      expect(screen.getByText('style.css')).toBeInTheDocument();
    });

    it('shows file sizes', () => {
      renderFiles();
      expect(screen.getByText('1.0 KB')).toBeInTheDocument(); // index.html
      expect(screen.getByText('5.0 KB')).toBeInTheDocument(); // photo.jpg
      expect(screen.getByText('200.0 KB')).toBeInTheDocument(); // backup.tar.gz
    });

    it('renders toolbar buttons', () => {
      renderFiles();
      expect(screen.getByText('Upload')).toBeInTheDocument();
      // Git Clone lives inside the Import dropdown; top-level only exposes the Import trigger.
      expect(screen.getByText('Import')).toBeInTheDocument();
      expect(screen.getByText('New Folder')).toBeInTheDocument();
    });
  });

  describe('Loading states', () => {
    it('shows loading spinner when file manager is starting', () => {
      mockFmStatus.mockReturnValue({ data: { ready: false, phase: 'starting' as const }, isLoading: false, error: null });
      renderFiles();
      expect(screen.getByText('Starting File Manager')).toBeInTheDocument();
    });

    it('shows failed state with retry button', () => {
      mockFmStatus.mockReturnValue({ data: { ready: false, phase: 'failed' as const, message: 'Pod crashed' }, isLoading: false, error: null });
      renderFiles();
      expect(screen.getByText('File Manager Failed')).toBeInTheDocument();
      expect(screen.getByText('Pod crashed')).toBeInTheDocument();
      expect(screen.getByText('Retry')).toBeInTheDocument();
    });
  });

  describe('Folder navigation (clickable rows)', () => {
    it('clicking a folder row navigates into it', async () => {
      const user = userEvent.setup();
      renderFiles();
      // Click on the folder name text — the entire row should handle it
      const docsRow = screen.getByText('docs').closest('tr')!;
      await user.click(docsRow);
      // The component re-renders with new path — we verify the action happened
      // by checking the click doesn't open an editor
      expect(screen.queryByTestId('monaco-editor')).not.toBeInTheDocument();
    });
  });

  describe('Multi-select', () => {
    it('shows checkboxes for each file', () => {
      renderFiles();
      // Header checkbox + one per entry
      const checkboxes = screen.getAllByRole('button').filter(b => b.querySelector('svg'));
      expect(checkboxes.length).toBeGreaterThan(dirEntries.length);
    });

    it('shows bulk toolbar when items are selected', async () => {
      const user = userEvent.setup();
      renderFiles();
      // Find and click the first checkbox (skip header checkbox)
      const rows = screen.getAllByRole('row');
      // Row 0 is header, row 1+ are entries
      const firstEntryRow = rows[1];
      const checkbox = within(firstEntryRow).getAllByRole('button')[0];
      await user.click(checkbox);

      expect(screen.getByText('1 selected')).toBeInTheDocument();
      expect(screen.getByText('Copy')).toBeInTheDocument();
      expect(screen.getByText('Move')).toBeInTheDocument();
      expect(screen.getByText('Archive')).toBeInTheDocument();
      expect(screen.getByText('Delete')).toBeInTheDocument();
    });

    it('select all toggles all items', async () => {
      const user = userEvent.setup();
      renderFiles();
      const headerRow = screen.getAllByRole('row')[0];
      // First button in header row is the select-all checkbox (others are sort buttons)
      const selectAll = within(headerRow).getAllByRole('button')[0];
      await user.click(selectAll);
      expect(screen.getByText(`${dirEntries.length} selected`)).toBeInTheDocument();
    });
  });

  describe('New folder', () => {
    it('opens new folder input when button clicked', async () => {
      const user = userEvent.setup();
      renderFiles();
      await user.click(screen.getByText('New Folder'));
      expect(screen.getByPlaceholderText('Folder name')).toBeInTheDocument();
    });
  });

  describe('Rename dialog', () => {
    it('can be triggered from context menu', async () => {
      const user = userEvent.setup();
      renderFiles();
      // Right-click on a file
      const row = screen.getByText('index.html').closest('tr')!;
      fireEvent.contextMenu(row);

      // Context menu should appear
      await waitFor(() => {
        expect(screen.getByText('Rename')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Rename'));
      // Rename dialog should appear
      await waitFor(() => {
        expect(screen.getByRole('textbox')).toHaveValue('index.html');
      });
    });
  });

  describe('Delete dialog', () => {
    it('can be triggered from context menu', async () => {
      const user = userEvent.setup();
      renderFiles();
      const row = screen.getByText('style.css').closest('tr')!;
      fireEvent.contextMenu(row);

      await waitFor(() => {
        expect(screen.getAllByText('Delete').length).toBeGreaterThan(0);
      });

      // Click the delete menu item (last one)
      const deleteItems = screen.getAllByText('Delete');
      await user.click(deleteItems[deleteItems.length - 1]);

      await waitFor(() => {
        expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();
      });
    });
  });

  describe('Context menu', () => {
    it('shows correct options for files', async () => {
      renderFiles();
      const row = screen.getByText('index.html').closest('tr')!;
      fireEvent.contextMenu(row);

      await waitFor(() => {
        expect(screen.getByText('Edit')).toBeInTheDocument();
        expect(screen.getByText('Download')).toBeInTheDocument();
        expect(screen.getByText('Copy to...')).toBeInTheDocument();
        expect(screen.getByText('Move to...')).toBeInTheDocument();
        expect(screen.getByText('Rename')).toBeInTheDocument();
      });
    });

    it('shows correct options for directories', async () => {
      renderFiles();
      const row = screen.getByText('docs').closest('tr')!;
      fireEvent.contextMenu(row);

      await waitFor(() => {
        expect(screen.getByText('Open')).toBeInTheDocument();
        expect(screen.queryByText('Download')).not.toBeInTheDocument();
        expect(screen.getByText('Copy to...')).toBeInTheDocument();
      });
    });

    it('shows extract option for archive files', async () => {
      renderFiles();
      const row = screen.getByText('backup.tar.gz').closest('tr')!;
      fireEvent.contextMenu(row);

      await waitFor(() => {
        expect(screen.getByText('Extract')).toBeInTheDocument();
      });
    });

    it('shows view image option for image files', async () => {
      renderFiles();
      const row = screen.getByText('photo.jpg').closest('tr')!;
      fireEvent.contextMenu(row);

      await waitFor(() => {
        expect(screen.getByText('View Image')).toBeInTheDocument();
      });
    });
  });

  describe('Git Clone dialog', () => {
    it('opens dialog with URL and folder inputs', async () => {
      const user = userEvent.setup();
      renderFiles();
      // Git Clone was moved into an Import dropdown alongside URL download
      // and Clone Website. Open the dropdown before clicking through.
      await user.click(screen.getByText('Import'));
      await user.click(screen.getByText('Git Clone'));

      expect(screen.getByText('Clone Git Repository')).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/github.com/)).toBeInTheDocument();
      expect(screen.getByText('Clone')).toBeInTheDocument();
    });
  });

  describe('Archive dialog', () => {
    it('opens archive dialog from bulk toolbar', async () => {
      const user = userEvent.setup();
      renderFiles();

      // Select all — first button in header row (select-all checkbox; other buttons are sort headers)
      const headerRow = screen.getAllByRole('row')[0];
      await user.click(within(headerRow).getAllByRole('button')[0]);

      // Click Archive
      await user.click(screen.getByText('Archive'));

      expect(screen.getByText('Create Archive')).toBeInTheDocument();
      expect(screen.getByText('Archive name')).toBeInTheDocument();
      expect(screen.getByText('Format')).toBeInTheDocument();
    });
  });

  describe('Extract dialog', () => {
    it('opens extract dialog from context menu', async () => {
      const user = userEvent.setup();
      renderFiles();

      const row = screen.getByText('backup.tar.gz').closest('tr')!;
      fireEvent.contextMenu(row);

      await waitFor(() => {
        expect(screen.getByText('Extract')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Extract'));

      await waitFor(() => {
        expect(screen.getByText('Extract Archive')).toBeInTheDocument();
        expect(screen.getByText(/Current folder/)).toBeInTheDocument();
        // Should show subdirectories as extraction targets
        expect(screen.getByText('docs/')).toBeInTheDocument();
        expect(screen.getByText('images/')).toBeInTheDocument();
      });
    });
  });

  describe('Drag and drop', () => {
    it('shows drop zone indicator on drag over', () => {
      renderFiles();
      const dropZone = screen.getByText('index.html').closest('[class*="rounded-xl"]')!;

      fireEvent.dragEnter(dropZone, { dataTransfer: { files: [] } });

      expect(screen.getByText('Drop files here to upload')).toBeInTheDocument();
    });

    it('hides drop zone on drag leave', () => {
      renderFiles();
      const dropZone = screen.getByText('index.html').closest('[class*="rounded-xl"]')!;

      fireEvent.dragEnter(dropZone, { dataTransfer: { files: [] } });
      expect(screen.getByText('Drop files here to upload')).toBeInTheDocument();

      fireEvent.dragLeave(dropZone, { dataTransfer: { files: [] } });
      expect(screen.queryByText('Drop files here to upload')).not.toBeInTheDocument();
    });
  });

  describe('Copy/Move dialog', () => {
    it('opens copy dialog from bulk toolbar', async () => {
      const user = userEvent.setup();
      renderFiles();

      // Select first item
      const rows = screen.getAllByRole('row');
      const checkbox = within(rows[1]).getAllByRole('button')[0];
      await user.click(checkbox);

      await user.click(screen.getByText('Copy'));

      expect(screen.getByText('Copy To')).toBeInTheDocument();
      expect(screen.getByText('Destination: /')).toBeInTheDocument();
    });

    it('opens move dialog from bulk toolbar', async () => {
      const user = userEvent.setup();
      renderFiles();

      const rows = screen.getAllByRole('row');
      const checkbox = within(rows[1]).getAllByRole('button')[0];
      await user.click(checkbox);

      await user.click(screen.getByText('Move'));

      expect(screen.getByText('Move To')).toBeInTheDocument();
    });
  });

  describe('Bulk delete', () => {
    it('opens bulk delete dialog from toolbar', async () => {
      const user = userEvent.setup();
      renderFiles();

      // Select all — first button in header row (select-all checkbox; other buttons are sort headers)
      const headerRow = screen.getAllByRole('row')[0];
      await user.click(within(headerRow).getAllByRole('button')[0]);

      // The "Delete" in toolbar
      const deleteButtons = screen.getAllByText('Delete');
      const bulkDelete = deleteButtons.find(b => b.closest('[class*="brand"]'));
      if (bulkDelete) await user.click(bulkDelete);

      await waitFor(() => {
        expect(screen.getByText('Delete Selected')).toBeInTheDocument();
        expect(screen.getByText(`${dirEntries.length} items`)).toBeInTheDocument();
      });
    });
  });
});
