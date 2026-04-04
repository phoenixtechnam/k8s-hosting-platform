import { test, expect } from '@playwright/test';
import { loginAsAdminClient } from './helpers';

test.describe('Client Panel Full Workflow — End-to-End', () => {
  test('complete client workflow: login, navigate all pages, logout', async ({ page }) => {
    test.setTimeout(30000);
    // 1. Login
    await loginAsAdminClient(page);

    // 2. Dashboard renders with stat cards
    const statsGrid = page.getByTestId('quick-stats');
    await expect(statsGrid).toBeVisible({ timeout: 2000 });
    await expect(statsGrid.getByText('Domains')).toBeVisible();
    await expect(statsGrid.getByText('Applications')).toBeVisible();
    await expect(statsGrid.getByText('Backups')).toBeVisible();

    // 3. Navigate to Domains
    await page.getByRole('link', { name: 'Domains' }).click();
    await expect(page.getByTestId('domains-heading')).toBeVisible({ timeout: 2000 });
    const domainsContent = page.getByTestId('domains-loading')
      .or(page.getByTestId('domains-empty'))
      .or(page.getByTestId('domains-error'))
      .or(page.getByTestId('domains-table'));
    await expect(domainsContent).toBeVisible({ timeout: 2000 });

    // 4. Navigate to Applications
    await page.getByRole('link', { name: 'Applications' }).click();
    await expect(page.getByTestId('applications-heading')).toBeVisible({ timeout: 2000 });

    // 5. Navigate to Backups
    await page.getByRole('link', { name: 'Backups' }).click();
    const backupsHeading = page.getByTestId('backups-heading')
      .or(page.getByRole('heading', { name: 'Backups' }));
    await expect(backupsHeading).toBeVisible({ timeout: 2000 });

    // 6. Navigate to Email — shows email management page
    await page.getByRole('link', { name: 'Email' }).click();
    await expect(page.getByTestId('email-heading')).toBeVisible({ timeout: 2000 });

    // 7. Navigate to Files — shows file manager page
    await page.getByRole('link', { name: 'File Manager' }).click();
    await expect(page.getByTestId('files-heading')).toBeVisible({ timeout: 2000 });

    // 8. Navigate to Settings
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: /Settings/i })).toBeVisible({ timeout: 2000 });
    

    // 9. Logout via user menu
    const logoutMenuBtn = page.getByTestId('user-menu-button').or(page.getByRole('button', { name: 'User menu' }));
    await logoutMenuBtn.click();
    await page.waitForTimeout(200);
    const signOutBtn = page.getByTestId('user-menu-sign-out')
      .or(page.getByRole('button', { name: /sign out/i }))
      .or(page.getByText('Sign Out'));
    await signOutBtn.click();
    await expect(page.getByTestId('login-button').or(page.getByRole('button', { name: 'Sign In' }))).toBeVisible({ timeout: 2000 });
  });

  test('dashboard Getting Started section is visible', async ({ page }) => {
    await loginAsAdminClient(page);
    await expect(page.getByText('Getting Started')).toBeVisible({ timeout: 2000 });
  });

  test('sidebar shows all navigation items', async ({ page }) => {
    await loginAsAdminClient(page);

    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar).toBeVisible();

    for (const label of ['Dashboard', 'Domains', 'Applications', 'File Manager', 'Email', 'Backups', 'Settings']) {
      await expect(page.getByRole('link', { name: label })).toBeVisible();
    }
  });

  test('can return to Dashboard from any page', async ({ page }) => {
    await loginAsAdminClient(page);

    // Navigate away
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: /Settings/i })).toBeVisible({ timeout: 2000 });

    // Return to Dashboard
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page.getByTestId('welcome-heading')).toBeVisible({ timeout: 2000 });
  });

  test('Domains page shows empty state or table', async ({ page }) => {
    await loginAsAdminClient(page);

    await page.getByRole('link', { name: 'Domains' }).click();
    await expect(page.getByTestId('domains-heading')).toBeVisible({ timeout: 2000 });

    const content = page.getByTestId('domains-empty')
      .or(page.getByTestId('domains-table'))
      .or(page.getByTestId('domains-loading'))
      .or(page.getByTestId('domains-error'));
    await expect(content).toBeVisible({ timeout: 2000 });
  });

  test('Applications page loads correctly', async ({ page }) => {
    await loginAsAdminClient(page);

    await page.getByRole('link', { name: 'Applications' }).click();
    await expect(page.getByTestId('applications-heading')).toBeVisible({ timeout: 2000 });
  });

  test('Backups page loads correctly', async ({ page }) => {
    await loginAsAdminClient(page);

    await page.getByRole('link', { name: 'Backups' }).click();

    const heading = page.getByTestId('backups-heading')
      .or(page.getByRole('heading', { name: 'Backups' }));
    await expect(heading).toBeVisible({ timeout: 2000 });
  });

  test('Email page shows email management UI', async ({ page }) => {
    await loginAsAdminClient(page);

    await page.getByRole('link', { name: 'Email' }).click();
    await expect(page.getByTestId('email-heading')).toBeVisible({ timeout: 2000 });
  });

  test('Files page shows file manager UI', async ({ page }) => {
    await loginAsAdminClient(page);

    await page.getByRole('link', { name: 'File Manager' }).click();
    await expect(page.getByTestId('files-heading')).toBeVisible({ timeout: 2000 });
  });

  test('user menu shows profile info and change password option', async ({ page }) => {
    await loginAsAdminClient(page);

    // Profile and password are now in the header user menu, not Settings page
    const userMenuBtn = page.getByTestId('user-menu-button').or(page.getByRole('button', { name: 'User menu' }));
    await userMenuBtn.click();
    await page.waitForTimeout(200);

    // User info should be displayed in the dropdown (name and email)
    await expect(page.getByTestId('user-menu-dropdown')).toBeVisible({ timeout: 2000 });
    await expect(page.getByTestId('user-menu-name')).toBeVisible();
    await expect(page.getByTestId('user-menu-email')).toBeVisible();

    // Change Password option should be available
    await expect(page.getByTestId('change-password-menu-item')).toBeVisible({ timeout: 2000 });
  });

  test('multiple navigation cycles preserve session', async ({ page }) => {
    await loginAsAdminClient(page);

    // Navigate through multiple pages rapidly
    await page.getByRole('link', { name: 'Domains' }).click();
    await expect(page.getByTestId('domains-heading')).toBeVisible({ timeout: 2000 });

    await page.getByRole('link', { name: 'Applications' }).click();
    await expect(page.getByTestId('applications-heading')).toBeVisible({ timeout: 2000 });

    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: /Settings/i })).toBeVisible({ timeout: 2000 });

    // Back to dashboard — session should persist
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page.getByTestId('welcome-heading')).toBeVisible({ timeout: 2000 });
  });

  test('logout redirects to login page', async ({ page }) => {
    await loginAsAdminClient(page);

    // Open user menu and click Sign Out
    const menuBtn = page.getByTestId('user-menu-button').or(page.getByRole('button', { name: 'User menu' }));
    await menuBtn.click();
    await page.waitForTimeout(200);
    const signOut = page.getByTestId('user-menu-sign-out')
      .or(page.getByRole('button', { name: /sign out/i }))
      .or(page.getByText('Sign Out'));
    await signOut.click();

    await expect(page.getByTestId('login-button')).toBeVisible({ timeout: 2000 });
    await expect(page.getByText('Client Portal')).toBeVisible();
  });
});
