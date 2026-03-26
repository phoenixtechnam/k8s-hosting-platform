import { test, expect } from '@playwright/test';
import { loginAsAdminClient } from './helpers';

test.describe('Client Panel Full Workflow — End-to-End', () => {
  test('complete client workflow: login, navigate all pages, logout', async ({ page }) => {
    // 1. Login
    await loginAsAdminClient(page);

    // 2. Dashboard renders with stat cards
    const statsGrid = page.getByTestId('quick-stats');
    await expect(statsGrid).toBeVisible({ timeout: 10000 });
    await expect(statsGrid.getByText('Domains')).toBeVisible();
    await expect(statsGrid.getByText('Databases')).toBeVisible();
    await expect(statsGrid.getByText('Backups')).toBeVisible();

    // 3. Navigate to Domains
    await page.getByRole('link', { name: 'Domains' }).click();
    await expect(page.getByTestId('domains-heading')).toBeVisible({ timeout: 5000 });
    const domainsContent = page.getByTestId('domains-loading')
      .or(page.getByTestId('domains-empty'))
      .or(page.getByTestId('domains-error'))
      .or(page.getByTestId('domains-table'));
    await expect(domainsContent).toBeVisible({ timeout: 10000 });

    // 4. Navigate to Databases
    await page.getByRole('link', { name: 'Databases' }).click();
    await expect(page.getByTestId('databases-heading')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('create-database-button')).toBeVisible();

    // 5. Navigate to Backups
    await page.getByRole('link', { name: 'Backups' }).click();
    const backupsHeading = page.getByTestId('backups-heading')
      .or(page.getByRole('heading', { name: 'Backups' }));
    await expect(backupsHeading).toBeVisible({ timeout: 5000 });

    // 6. Navigate to Email — shows "Coming Soon"
    await page.getByRole('link', { name: 'Email' }).click();
    await expect(page.getByText('Coming Soon')).toBeVisible({ timeout: 5000 });

    // 7. Navigate to Files — shows "Coming Soon"
    await page.getByRole('link', { name: 'Files' }).click();
    await expect(page.getByText('Coming Soon')).toBeVisible({ timeout: 5000 });

    // 8. Navigate to Settings
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: /Settings/i })).toBeVisible({ timeout: 5000 });
    

    // 9. Logout
    const logoutButton = page.getByTestId('user-menu-button');
    await expect(logoutButton).toBeVisible();
    await logoutButton.click();
    await expect(page.getByTestId('login-button')).toBeVisible({ timeout: 10000 });
  });

  test('dashboard Getting Started section is visible', async ({ page }) => {
    await loginAsAdminClient(page);
    await expect(page.getByText('Getting Started')).toBeVisible({ timeout: 10000 });
  });

  test('sidebar shows all navigation items', async ({ page }) => {
    await loginAsAdminClient(page);

    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar).toBeVisible();

    for (const label of ['Dashboard', 'Domains', 'Databases', 'Files', 'Email', 'Backups', 'Settings']) {
      await expect(page.getByRole('link', { name: label })).toBeVisible();
    }
  });

  test('can return to Dashboard from any page', async ({ page }) => {
    await loginAsAdminClient(page);

    // Navigate away
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: /Settings/i })).toBeVisible({ timeout: 5000 });

    // Return to Dashboard
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page.getByTestId('welcome-heading')).toBeVisible({ timeout: 10000 });
  });

  test('Domains page shows empty state or table', async ({ page }) => {
    await loginAsAdminClient(page);

    await page.getByRole('link', { name: 'Domains' }).click();
    await expect(page.getByTestId('domains-heading')).toBeVisible({ timeout: 5000 });

    const content = page.getByTestId('domains-empty')
      .or(page.getByTestId('domains-table'))
      .or(page.getByTestId('domains-loading'))
      .or(page.getByTestId('domains-error'));
    await expect(content).toBeVisible({ timeout: 10000 });
  });

  test('Databases page shows create button and content', async ({ page }) => {
    await loginAsAdminClient(page);

    await page.getByRole('link', { name: 'Databases' }).click();
    await expect(page.getByTestId('databases-heading')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('create-database-button')).toBeVisible();

    const content = page.getByTestId('databases-empty')
      .or(page.getByTestId('databases-table'))
      .or(page.getByTestId('databases-loading'))
      .or(page.getByTestId('databases-error'));
    await expect(content).toBeVisible({ timeout: 10000 });
  });

  test('Backups page loads correctly', async ({ page }) => {
    await loginAsAdminClient(page);

    await page.getByRole('link', { name: 'Backups' }).click();

    const heading = page.getByTestId('backups-heading')
      .or(page.getByRole('heading', { name: 'Backups' }));
    await expect(heading).toBeVisible({ timeout: 5000 });
  });

  test('Email page shows Coming Soon placeholder', async ({ page }) => {
    await loginAsAdminClient(page);

    await page.getByRole('link', { name: 'Email' }).click();
    await expect(page.getByText('Coming Soon')).toBeVisible({ timeout: 5000 });
  });

  test('Files page shows Coming Soon placeholder', async ({ page }) => {
    await loginAsAdminClient(page);

    await page.getByRole('link', { name: 'Files' }).click();
    await expect(page.getByText('Coming Soon')).toBeVisible({ timeout: 5000 });
  });

  test('Settings page shows profile and password sections', async ({ page }) => {
    await loginAsAdminClient(page);

    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: /Settings/i })).toBeVisible({ timeout: 5000 });
    
    await expect(page.getByTestId('profile-email')).toBeVisible();
    
    await expect(page.getByTestId('update-password-button')).toBeVisible();
  });

  test('multiple navigation cycles preserve session', async ({ page }) => {
    await loginAsAdminClient(page);

    // Navigate through multiple pages rapidly
    await page.getByRole('link', { name: 'Domains' }).click();
    await expect(page.getByTestId('domains-heading')).toBeVisible({ timeout: 5000 });

    await page.getByRole('link', { name: 'Databases' }).click();
    await expect(page.getByTestId('databases-heading')).toBeVisible({ timeout: 5000 });

    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: /Settings/i })).toBeVisible({ timeout: 5000 });

    // Back to dashboard — session should persist
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page.getByTestId('welcome-heading')).toBeVisible({ timeout: 10000 });
  });

  test('logout redirects to login page', async ({ page }) => {
    await loginAsAdminClient(page);

    const logoutButton = page.getByTestId('user-menu-button');
    await expect(logoutButton).toBeVisible();
    await logoutButton.click();

    await expect(page.getByTestId('login-button')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Client Portal')).toBeVisible();
  });
});
