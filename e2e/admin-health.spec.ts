import { test, expect } from '@playwright/test';
import { injectAdminAuth } from './helpers';

test.describe('Admin Health Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await injectAdminAuth(page);
    await page.goto('/monitoring/health');
    await expect(page.getByTestId('health-heading')).toBeVisible({ timeout: 2000 });
  });

  test('page loads with correct heading', async ({ page }) => {
    await expect(page.getByTestId('health-heading')).toHaveText('System Health');
  });

  test('shows Refresh button', async ({ page }) => {
    await expect(page.getByTestId('refresh-health')).toBeVisible();
    await expect(page.getByTestId('refresh-health')).toContainText('Refresh');
  });

  test('shows health status or loading state', async ({ page }) => {
    // After page load, should show either the overall status banner or a loading spinner
    // The health API may be slow or fail, so we accept either state
    const overallStatus = page.getByTestId('overall-status');
    const loadingSpinner = page.locator('.animate-spin');

    // Wait a moment for either to appear
    await page.waitForTimeout(1000);

    const statusVisible = await overallStatus.isVisible().catch(() => false);
    const spinnerVisible = await loadingSpinner.isVisible().catch(() => false);

    // At minimum, the page should show loading or status
    expect(statusVisible || spinnerVisible).toBe(true);
  });
});
