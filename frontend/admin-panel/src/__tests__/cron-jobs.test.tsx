import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import CronJobs from '../pages/CronJobs';
import CreateCronJobModal from '../components/CreateCronJobModal';

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

describe('CronJobs page', () => {
  it('renders heading with Clock icon', () => {
    render(<CronJobs />, { wrapper: createWrapper() });
    expect(screen.getByText('Cron Jobs')).toBeInTheDocument();
  });

  it('renders client selector', () => {
    render(<CronJobs />, { wrapper: createWrapper() });
    expect(screen.getByTestId('client-selector')).toBeInTheDocument();
    expect(screen.getByText('All Clients')).toBeInTheDocument();
  });

  it('shows all clients by default without a prompt to select', () => {
    render(<CronJobs />, { wrapper: createWrapper() });
    expect(screen.queryByTestId('select-client-prompt')).not.toBeInTheDocument();
  });

  it('renders Add Cron Job button', () => {
    render(<CronJobs />, { wrapper: createWrapper() });
    expect(screen.getByTestId('add-cron-job-button')).toBeInTheDocument();
    expect(screen.getByText('Add Cron Job')).toBeInTheDocument();
  });

  it('disables Add Cron Job button when no client selected', () => {
    render(<CronJobs />, { wrapper: createWrapper() });
    expect(screen.getByTestId('add-cron-job-button')).toBeDisabled();
  });
});

describe('CreateCronJobModal', () => {
  it('renders form fields when open', () => {
    const onClose = vi.fn();
    render(<CreateCronJobModal open={true} onClose={onClose} clientId="client-1" />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('create-cron-job-modal')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Add Cron Job' })).toBeInTheDocument();
    expect(screen.getByTestId('cron-job-name-input')).toBeInTheDocument();
    expect(screen.getByTestId('cron-job-schedule-input')).toBeInTheDocument();
    expect(screen.getByTestId('cron-job-command-input')).toBeInTheDocument();
    expect(screen.getByTestId('cron-job-enabled-checkbox')).toBeInTheDocument();
  });

  it('is hidden when closed', () => {
    const onClose = vi.fn();
    render(<CreateCronJobModal open={false} onClose={onClose} clientId="client-1" />, {
      wrapper: createWrapper(),
    });
    expect(screen.queryByTestId('create-cron-job-modal')).not.toBeInTheDocument();
  });

  it('has required name field', () => {
    const onClose = vi.fn();
    render(<CreateCronJobModal open={true} onClose={onClose} clientId="client-1" />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('cron-job-name-input')).toBeRequired();
  });

  it('has required schedule field', () => {
    const onClose = vi.fn();
    render(<CreateCronJobModal open={true} onClose={onClose} clientId="client-1" />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('cron-job-schedule-input')).toBeRequired();
  });

  it('has required command field', () => {
    const onClose = vi.fn();
    render(<CreateCronJobModal open={true} onClose={onClose} clientId="client-1" />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('cron-job-command-input')).toBeRequired();
  });

  it('defaults enabled checkbox to checked', () => {
    const onClose = vi.fn();
    render(<CreateCronJobModal open={true} onClose={onClose} clientId="client-1" />, {
      wrapper: createWrapper(),
    });
    const checkbox = screen.getByTestId('cron-job-enabled-checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it('has submit and cancel buttons', () => {
    const onClose = vi.fn();
    render(<CreateCronJobModal open={true} onClose={onClose} clientId="client-1" />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('submit-cron-job-button')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });
});
