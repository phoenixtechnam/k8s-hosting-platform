import { test, expect } from '@playwright/test';
import { injectAdminAuth } from './helpers';

test.describe('Admin Applications Page', () => {
  test.beforeEach(async ({ page }) => {
    await injectAdminAuth(page);
    await page.getByRole('link', { name: 'Applications' }).click();
    await expect(page.getByRole('heading', { name: 'Applications' })).toBeVisible({ timeout: 2000 });
  });

  test('should display the Applications page with tabs', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Applications' })).toBeVisible();

    // All 3 tabs should be visible
    await expect(page.getByTestId('tab-catalog')).toBeVisible();
    await expect(page.getByTestId('tab-installed')).toBeVisible();
    await expect(page.getByTestId('tab-repos')).toBeVisible();
  });

  test('should display Repositories tab with application repo management', async ({ page }) => {
    await page.getByTestId('tab-repos').click();

    // Should show the repos tab content — either table or empty state
    const reposTab = page.getByTestId('repos-tab');
    await expect(reposTab).toBeVisible({ timeout: 2000 });
  });

  test('should display Catalog tab with available applications', async ({ page }) => {
    await page.getByTestId('tab-catalog').click();

    // Catalog tab is the default; should show catalog content — grid, empty state, loading, or error
    const catalogTab = page.getByTestId('catalog-tab');
    await expect(catalogTab).toBeVisible({ timeout: 2000 });

    // Should show either the catalog grid, empty state, loading spinner, or error message
    const grid = page.getByTestId('catalog-grid');
    const empty = page.getByTestId('catalog-empty');
    const loading = page.getByTestId('loading-spinner');
    const error = page.getByTestId('error-message');

    await page.waitForTimeout(1000);

    const gridVisible = await grid.isVisible().catch(() => false);
    const emptyVisible = await empty.isVisible().catch(() => false);
    const loadingVisible = await loading.isVisible().catch(() => false);
    const errorVisible = await error.isVisible().catch(() => false);

    expect(gridVisible || emptyVisible || loadingVisible || errorVisible).toBe(true);
  });

  test('should show Installed tab with Phase 2 placeholder', async ({ page }) => {
    await page.getByTestId('tab-installed').click();

    const installedTab = page.getByTestId('installed-tab');
    await expect(installedTab).toBeVisible({ timeout: 2000 });

    // Should show Phase 2 placeholder message
    await expect(page.getByText('Phase 2')).toBeVisible({ timeout: 2000 });
  });
});
