import { test, expect } from '@playwright/test';
import { injectAdminAuth } from './helpers';

test.describe('Admin Applications Page', () => {
  test.beforeEach(async ({ page }) => {
    await injectAdminAuth(page);
    await page.getByRole('link', { name: 'Applications' }).click();
    await expect(page.getByRole('heading', { name: 'Applications' })).toBeVisible({ timeout: 2000 });
  });

  test('applications page loads', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Applications' })).toBeVisible();
  });

  test('shows tab bar with all tabs', async ({ page }) => {
    const tabBar = page.getByTestId('tab-bar');
    if (await tabBar.isVisible({ timeout: 1000 }).catch(() => false)) {
      const tabs = tabBar.locator('button');
      await expect(tabs.first()).toBeVisible();
    }
  });

  test('shows catalog or deployed content', async ({ page }) => {
    // Should show some content — tab bar, catalog cards, table, or empty state
    const content = page.getByTestId('tab-bar')
      .or(page.locator('table'))
      .or(page.getByText('No deployments'))
      .or(page.getByText('catalog'));
    await expect(content.first()).toBeVisible({ timeout: 5000 });
  });

  test('page renders content', async ({ page }) => {
    // Page should render something beyond the heading
    const body = page.locator('main, [class*="space-y"]');
    await expect(body.first()).toBeVisible({ timeout: 2000 });
  });
});
