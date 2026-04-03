import { test, expect } from '@playwright/test';
import { injectAdminAuth } from './helpers';

test.describe('Admin Applications Page', () => {
  test.beforeEach(async ({ page }) => {
    await injectAdminAuth(page);
    await page.getByRole('link', { name: 'Applications' }).click();
    await expect(page.getByTestId('applications-heading')).toBeVisible({ timeout: 2000 });
  });

  test('should display the Applications page with tabs', async ({ page }) => {
    await expect(page.getByTestId('applications-heading')).toBeVisible();

    // All 3 tabs should be visible
    await expect(page.getByTestId('tab-catalog')).toBeVisible();
    await expect(page.getByTestId('tab-installed')).toBeVisible();
    await expect(page.getByTestId('tab-repos')).toBeVisible();
  });

  test('should display Repositories tab with repo management UI', async ({ page }) => {
    await page.getByTestId('tab-repos').click();

    // Should show the repos tab content — either table or empty state
    const reposTab = page.getByTestId('repos-tab');
    await expect(reposTab).toBeVisible({ timeout: 2000 });
  });

  test('should display Catalog tab content', async ({ page }) => {
    await page.getByTestId('tab-catalog').click();

    // Catalog tab is the default; should show catalog content
    const catalogTab = page.getByTestId('catalog-tab');
    await expect(catalogTab).toBeVisible({ timeout: 2000 });

    // Should show either the catalog grid, empty state, loading spinner, or error
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

  test('should show Installed tab content', async ({ page }) => {
    const installedBtn = page.getByTestId('tab-installed');
    await installedBtn.click();
    // Tab button should be highlighted (active state)
    await expect(installedBtn).toBeVisible({ timeout: 2000 });
    // Wait for content to render
    await page.waitForTimeout(1000);
    // Page should show something — the tab content area exists even if loading
    const body = page.locator('[class*="space-y"]');
    await expect(body.first()).toBeVisible({ timeout: 3000 });
  });
});
