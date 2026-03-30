import { test, expect } from '@playwright/test';
import { injectAdminAuth } from './helpers';

test.describe('Admin Backup Settings', () => {
  test.beforeEach(async ({ page }) => {
    await injectAdminAuth(page);
    await page.goto('/settings/backups');
    await expect(page.getByTestId('backup-settings-heading')).toBeVisible({ timeout: 3000 });
  });

  test('backup settings page loads with heading', async ({ page }) => {
    await expect(page.getByTestId('backup-settings-heading')).toHaveText('Backup Configuration');
  });

  test('shows add backup config button', async ({ page }) => {
    const addButton = page.getByRole('button', { name: /Add|Create/i });
    await expect(addButton).toBeVisible();
  });

  test('shows config list or empty state', async ({ page }) => {
    const content = page.getByText('No backup configurations')
      .or(page.getByText('SSH'))
      .or(page.getByText('S3'));
    await expect(content).toBeVisible({ timeout: 2000 });
  });
});
