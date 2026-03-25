import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

test.describe('Admin Monitoring Page', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.getByRole('link', { name: 'Monitoring' }).click();
    await expect(page.getByRole('heading', { name: 'Monitoring' })).toBeVisible({ timeout: 5000 });
  });

  test('monitoring page loads', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Monitoring' })).toBeVisible();
  });

  test('shows stat cards', async ({ page }) => {
    await expect(page.getByText('Platform Status')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Active Alerts')).toBeVisible();
    await expect(page.getByText('Avg Response Time')).toBeVisible();
    await expect(page.getByText('Error Rate')).toBeVisible();
  });

  test('has 3 tabs (Active Alerts, Alert History, System Metrics)', async ({ page }) => {
    await expect(page.getByTestId('tab-active-alerts')).toBeVisible();
    await expect(page.getByTestId('tab-alert-history')).toBeVisible();
    await expect(page.getByTestId('tab-system-metrics')).toBeVisible();
  });

  test('can switch to Alert History tab', async ({ page }) => {
    await page.getByTestId('tab-alert-history').click();
    // Should show either alerts table, loading, or empty state
    const table = page.getByTestId('alerts-table');
    const loading = page.getByTestId('alerts-loading');
    const empty = page.getByTestId('alerts-empty');

    const tableVisible = await table.isVisible().catch(() => false);
    const loadingVisible = await loading.isVisible().catch(() => false);
    const emptyVisible = await empty.isVisible().catch(() => false);

    expect(tableVisible || loadingVisible || emptyVisible).toBe(true);
  });

  test('System Metrics tab shows resource bars', async ({ page }) => {
    await page.getByTestId('tab-system-metrics').click();
    const metricsPanel = page.getByTestId('system-metrics');
    await expect(metricsPanel).toBeVisible({ timeout: 5000 });

    await expect(page.getByText('CPU Usage')).toBeVisible();
    await expect(page.getByText('Memory Usage')).toBeVisible();
    await expect(page.getByText('Disk Usage')).toBeVisible();
    await expect(page.getByText('Network I/O')).toBeVisible();
  });
});
