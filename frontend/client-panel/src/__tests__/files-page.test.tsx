import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect } from 'vitest';
import Files from '../pages/Files';

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

describe('Files Page', () => {
  it('renders the heading', () => {
    renderWithProviders(<Files />);
    expect(screen.getByTestId('files-heading')).toBeInTheDocument();
    expect(screen.getByText('Files')).toBeInTheDocument();
  });

  it('renders the description', () => {
    renderWithProviders(<Files />);
    expect(screen.getByText('Manage your website files and directories.')).toBeInTheDocument();
  });

  it('shows coming soon placeholder', () => {
    renderWithProviders(<Files />);
    expect(screen.getByTestId('files-coming-soon')).toBeInTheDocument();
    expect(screen.getByText(/Coming Soon/)).toBeInTheDocument();
  });

  it('mentions FileBrowser deployment', () => {
    renderWithProviders(<Files />);
    expect(screen.getByText(/FileBrowser is deployed/)).toBeInTheDocument();
  });

  it('lists all planned features', () => {
    renderWithProviders(<Files />);
    expect(screen.getByText('Planned Features')).toBeInTheDocument();
    expect(screen.getByText('Upload/download files')).toBeInTheDocument();
    expect(screen.getByText('Directory management')).toBeInTheDocument();
    expect(screen.getByText('File editing')).toBeInTheDocument();
    expect(screen.getByText('SFTP access')).toBeInTheDocument();
  });
});
