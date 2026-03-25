import { test, expect } from '@playwright/test';
import { loginAsAdminClient } from './helpers';

test.describe('Client Panel Smoke Tests', () => {
  test('login page loads', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByText('Client Portal')).toBeVisible();
    await expect(page.getByTestId('email-input')).toBeVisible();
    await expect(page.getByTestId('password-input')).toBeVisible();
    await expect(page.getByTestId('login-button')).toBeVisible();
  });

  test('can login with admin credentials', async ({ page }) => {
    await loginAsAdminClient(page);
  });

  test('dashboard shows quick stats after login', async ({ page }) => {
    await loginAsAdminClient(page);

    // The dashboard should show the quick stats grid
    const statsGrid = page.getByTestId('quick-stats');
    await expect(statsGrid).toBeVisible({ timeout: 10000 });

    // Verify stat labels within the grid (not sidebar links)
    await expect(statsGrid.getByText('Domains')).toBeVisible();
    await expect(statsGrid.getByText('Databases')).toBeVisible();
    await expect(statsGrid.getByText('Backups')).toBeVisible();
  });

  test('dashboard shows getting started section', async ({ page }) => {
    await loginAsAdminClient(page);

    await expect(page.getByText('Getting Started')).toBeVisible({ timeout: 10000 });
  });

  test('can navigate to Domains page', async ({ page }) => {
    await loginAsAdminClient(page);

    await page.getByRole('link', { name: 'Domains' }).click();
    await expect(page.getByTestId('domains-heading')).toBeVisible({ timeout: 5000 });

    // Should show loading, empty state, error, or table
    const content = page.getByTestId('domains-loading')
      .or(page.getByTestId('domains-empty'))
      .or(page.getByTestId('domains-error'))
      .or(page.getByTestId('domains-table'));
    await expect(content).toBeVisible({ timeout: 10000 });
  });

  test('can navigate to Databases page', async ({ page }) => {
    await loginAsAdminClient(page);

    await page.getByRole('link', { name: 'Databases' }).click();
    await expect(page.getByTestId('databases-heading')).toBeVisible({ timeout: 5000 });

    // Should show create button
    await expect(page.getByTestId('create-database-button')).toBeVisible();

    // Should show loading, empty state, error, or table
    const content = page.getByTestId('databases-loading')
      .or(page.getByTestId('databases-empty'))
      .or(page.getByTestId('databases-error'))
      .or(page.getByTestId('databases-table'));
    await expect(content).toBeVisible({ timeout: 10000 });
  });

  test('can navigate to Settings page', async ({ page }) => {
    await loginAsAdminClient(page);

    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByTestId('settings-heading')).toBeVisible({ timeout: 5000 });

    // Profile section
    await expect(page.getByTestId('profile-section')).toBeVisible();
    await expect(page.getByTestId('profile-email')).toBeVisible();

    // Change password section
    await expect(page.getByTestId('change-password-section')).toBeVisible();
    await expect(page.getByTestId('update-password-button')).toBeVisible();
  });

  test('sidebar navigation items are present', async ({ page }) => {
    await loginAsAdminClient(page);

    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar).toBeVisible();

    // All nav items should be visible
    for (const label of ['Dashboard', 'Domains', 'Databases', 'Files', 'Email', 'Backups', 'Settings']) {
      await expect(page.getByRole('link', { name: label })).toBeVisible();
    }
  });

  test('logout button is present', async ({ page }) => {
    await loginAsAdminClient(page);

    await expect(page.getByTestId('logout-button')).toBeVisible();
  });
});
