import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

test.describe('Admin Workloads Page', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.getByRole('link', { name: 'Workloads' }).click();
    await expect(page.getByRole('heading', { name: 'Workloads' })).toBeVisible({ timeout: 5000 });
  });

  test('workloads page loads', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Workloads' })).toBeVisible();
  });

  test('shows stat cards', async ({ page }) => {
    await expect(page.getByText('Total Images')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Active Workloads')).toBeVisible();
    await expect(page.getByText('Deployments Today')).toBeVisible();
  });

  test('shows container images table or loading/error state', async ({ page }) => {
    const table = page.getByTestId('images-table');
    const loading = page.getByTestId('loading-spinner');
    const error = page.getByTestId('error-message');

    // One of table, loading, or error should be visible
    const tableVisible = await table.isVisible().catch(() => false);
    const loadingVisible = await loading.isVisible().catch(() => false);
    const errorVisible = await error.isVisible().catch(() => false);

    expect(tableVisible || loadingVisible || errorVisible).toBe(true);
  });

  test('search input is present', async ({ page }) => {
    const searchInput = page.getByTestId('image-search');
    await expect(searchInput).toBeVisible();
    await expect(searchInput).toHaveAttribute('placeholder', 'Search images...');
  });
});
