import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

test.describe('Admin Storage Page', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.getByRole('link', { name: 'Storage & DB' }).click();
    await expect(page.getByRole('heading', { name: 'Storage & DB', exact: true })).toBeVisible({ timeout: 5000 });
  });

  test('storage page loads', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Storage & DB', exact: true })).toBeVisible();
  });

  test('shows stat cards', async ({ page }) => {
    const cards = page.locator('[data-testid="stat-card"]');
    await expect(cards.first()).toBeVisible({ timeout: 5000 });
  });

  test('page has content sections', async ({ page }) => {
    // The page should have some content - stat cards, tables, or resource bars
    const content = page.locator('[data-testid="stat-card"], table, [role="progressbar"]');
    await expect(content.first()).toBeVisible({ timeout: 5000 });
  });

  test('shows resource bars in overview', async ({ page }) => {
    const bars = page.locator('[role="progressbar"]');
    await expect(bars.first()).toBeVisible({ timeout: 5000 });
  });
});
