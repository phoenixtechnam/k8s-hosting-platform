import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

test.describe('Admin Storage Page', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.getByRole('link', { name: 'Storage' }).click();
    await expect(page.getByRole('heading', { name: 'Storage' })).toBeVisible({ timeout: 5000 });
  });

  test('storage page loads', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /Storage/ })).toBeVisible();
  });

  test('shows stat cards', async ({ page }) => {
    await expect(page.getByText('Total Storage')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Databases')).toBeVisible();
    await expect(page.getByText('Backups')).toBeVisible();
    await expect(page.getByText('Storage Used')).toBeVisible();
  });

  test('has 3 tabs (Overview, Databases, Backups)', async ({ page }) => {
    await expect(page.getByTestId('tab-overview')).toBeVisible();
    await expect(page.getByTestId('tab-databases')).toBeVisible();
    await expect(page.getByTestId('tab-backups')).toBeVisible();
  });

  test('can switch to Databases tab', async ({ page }) => {
    await page.getByTestId('tab-databases').click();
    // Databases tab shows a client selector
    await expect(page.getByTestId('client-selector')).toBeVisible({ timeout: 5000 });
  });

  test('can switch to Backups tab', async ({ page }) => {
    await page.getByTestId('tab-backups').click();
    // Backups tab shows a client selector
    await expect(page.getByTestId('client-selector')).toBeVisible({ timeout: 5000 });
  });

  test('overview tab shows storage allocation', async ({ page }) => {
    // Overview tab is active by default
    await expect(page.getByText('Storage Allocation')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Block Storage')).toBeVisible();
    await expect(page.getByText('Database Storage')).toBeVisible();
    await expect(page.getByText('Backup Storage')).toBeVisible();
  });
});
