import { test, expect } from '@playwright/test';
import { injectAdminAuth } from './helpers';

test.describe('Admin Plan Management', () => {
  test.beforeEach(async ({ page }) => {
    await injectAdminAuth(page);
    await page.goto('/settings/plans');
    await expect(page.getByTestId('plan-management-page')).toBeVisible({ timeout: 3000 });
  });

  test('plan management page loads with heading', async ({ page }) => {
    await expect(page.getByText('Hosting Plans')).toBeVisible();
  });

  test('shows Add Plan button', async ({ page }) => {
    await expect(page.getByTestId('add-plan-button')).toBeVisible();
  });

  test('shows plan list or empty state', async ({ page }) => {
    const content = page.getByText('No hosting plans configured.')
      .or(page.getByTestId('plan-management-page').locator('.divide-y'));
    await expect(content).toBeVisible({ timeout: 2000 });
  });
});
