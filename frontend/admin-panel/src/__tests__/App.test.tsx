import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import App from '../App';
import Layout from '../components/layout/Layout';
import Dashboard from '../pages/Dashboard';
import Clients from '../pages/Clients';
import Placeholder from '../pages/Placeholder';

function renderWithRouter(ui: React.ReactElement, route = '/') {
  return render(<MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>);
}

describe('App', () => {
  it('renders without crashing', () => {
    render(<App />);
    expect(screen.getByTestId('layout')).toBeInTheDocument();
  });

  it('renders dashboard by default', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });
});

describe('Layout', () => {
  it('renders sidebar and header', () => {
    renderWithRouter(<Layout />);
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('menu-button')).toBeInTheDocument();
  });

  it('shows sidebar nav items', () => {
    renderWithRouter(<Layout />);
    expect(screen.getByText('Clients')).toBeInTheDocument();
    expect(screen.getByText('Monitoring')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });
});

describe('Dashboard', () => {
  it('renders stat cards', () => {
    renderWithRouter(<Dashboard />);
    expect(screen.getByText('Total Clients')).toBeInTheDocument();
    expect(screen.getAllByText('Domains').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Storage').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Active Alerts')).toBeInTheDocument();
  });

  it('renders recent clients table', () => {
    renderWithRouter(<Dashboard />);
    expect(screen.getByTestId('clients-table')).toBeInTheDocument();
    expect(screen.getByText('Tech Startup Inc')).toBeInTheDocument();
  });

  it('shows View all link', () => {
    renderWithRouter(<Dashboard />);
    const link = screen.getByText('View all');
    expect(link).toHaveAttribute('href', '/clients');
  });
});

describe('Clients', () => {
  it('renders client list with search', () => {
    renderWithRouter(<Clients />);
    expect(screen.getByTestId('client-search')).toBeInTheDocument();
    expect(screen.getByTestId('plan-filter')).toBeInTheDocument();
    expect(screen.getByTestId('status-filter')).toBeInTheDocument();
  });

  it('shows all mock clients', () => {
    renderWithRouter(<Clients />);
    expect(screen.getByText('Tech Startup Inc')).toBeInTheDocument();
    expect(screen.getByText('Design Studio')).toBeInTheDocument();
    expect(screen.getByText('Local Bakery')).toBeInTheDocument();
  });

  it('displays Add Client button', () => {
    renderWithRouter(<Clients />);
    expect(screen.getByText('Add Client')).toBeInTheDocument();
  });
});

describe('Placeholder', () => {
  it('renders with provided title', () => {
    renderWithRouter(<Placeholder title="Domains" />);
    expect(screen.getByText('Domains')).toBeInTheDocument();
    expect(screen.getByText('This page is under construction.')).toBeInTheDocument();
  });
});
