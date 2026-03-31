import { test, expect } from '@playwright/test';
import { injectAdminAuth } from './helpers';

test.describe('Admin Workloads Page', () => {
  test.beforeEach(async ({ page }) => {
    await injectAdminAuth(page);
    await page.getByRole('link', { name: 'Workloads' }).click();
    await expect(page.getByRole('heading', { name: 'Workloads' })).toBeVisible({ timeout: 2000 });
  });

  test('workloads page loads', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Workloads' })).toBeVisible();
  });

  test('shows tab bar with all tabs', async ({ page }) => {
    await expect(page.getByTestId('tab-deployed')).toBeVisible({ timeout: 2000 });
    await expect(page.getByTestId('tab-available')).toBeVisible();
    await expect(page.getByTestId('tab-repos')).toBeVisible();
  });

  test('shows deployed workloads tab content', async ({ page }) => {
    // Default tab is "Deployed Workloads"
    await expect(page.getByTestId('tab-deployed')).toBeVisible({ timeout: 2000 });

    // Should show client selector or workloads table or empty state
    const clientSelect = page.getByTestId('client-search-select');
    const table = page.locator('table');
    const content = clientSelect.or(table);
    await expect(content).toBeVisible({ timeout: 2000 });
  });

  test('workloads page renders content', async ({ page }) => {
    // Page should render something — heading is already verified in beforeEach
    // Check for tab bar content
    await expect(page.getByTestId('tab-bar')).toBeVisible({ timeout: 2000 });
  });
});
