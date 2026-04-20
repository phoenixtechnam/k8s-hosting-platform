import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Users } from 'lucide-react';
import StatCard from '../components/ui/StatCard';
import StatusBadge from '../components/ui/StatusBadge';
import ResourceBar from '../components/ui/ResourceBar';

describe('StatCard', () => {
  it('renders title and value', () => {
    render(<StatCard title="Total Clients" value={42} icon={Users} />);
    expect(screen.getByText('Total Clients')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('renders subtitle when provided', () => {
    render(<StatCard title="Clients" value={42} subtitle="5 new" icon={Users} />);
    expect(screen.getByText('5 new')).toBeInTheDocument();
  });

  it('applies accent color class', () => {
    render(<StatCard title="Alerts" value={3} icon={Users} accent="red" />);
    const card = screen.getByTestId('stat-card');
    expect(card.className).toContain('border-l-red-500');
  });
});

describe('StatusBadge', () => {
  it('renders active status', () => {
    render(<StatusBadge status="active" />);
    const badge = screen.getByTestId('status-badge');
    expect(badge).toHaveTextContent('Active');
    expect(badge.className).toContain('bg-green-100');
  });

  it('renders suspended status', () => {
    render(<StatusBadge status="suspended" />);
    expect(screen.getByTestId('status-badge')).toHaveTextContent('Suspended');
  });

  it('accepts custom label', () => {
    render(<StatusBadge status="active" label="Online" />);
    expect(screen.getByTestId('status-badge')).toHaveTextContent('Online');
  });

  it('renders archived status with neutral styling', () => {
    render(<StatusBadge status="archived" />);
    const badge = screen.getByTestId('status-badge');
    expect(badge).toHaveTextContent('Archived');
    // archived uses slate/neutral palette, distinct from active/suspended
    expect(badge.className).toMatch(/bg-(slate|zinc|gray)-200|bg-slate-100/);
  });

  it('renders storage-lifecycle states (snapshotting, resizing, archiving, restoring)', () => {
    for (const s of ['snapshotting', 'resizing', 'archiving', 'restoring'] as const) {
      const { unmount } = render(<StatusBadge status={s} />);
      const badge = screen.getByTestId('status-badge');
      // transient states use blue/amber (in-progress family)
      expect(badge.className).toMatch(/bg-(blue|amber|indigo|sky)-/);
      unmount();
    }
  });
});

describe('ResourceBar', () => {
  it('renders with label and values', () => {
    render(<ResourceBar label="Storage" used={50} total={100} unit=" GB" />);
    expect(screen.getByText('Storage')).toBeInTheDocument();
    expect(screen.getByText('50 GB / 100 GB')).toBeInTheDocument();
  });

  it('renders progressbar with correct percentage', () => {
    render(<ResourceBar used={75} total={100} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '75');
  });

  it('caps at 100%', () => {
    render(<ResourceBar used={150} total={100} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '100');
  });

  it('handles zero total', () => {
    render(<ResourceBar used={0} total={0} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '0');
  });
});
