import { test, expect } from '@playwright/test';
import { injectAdminAuth } from './helpers';

test.describe('Admin Settings Page', () => {
  test.beforeEach(async ({ page }) => {
    await injectAdminAuth(page);
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByTestId('settings-heading')).toBeVisible({ timeout: 2000 });
  });

  test('settings page loads with correct heading', async ({ page }) => {
    await expect(page.getByTestId('settings-heading')).toHaveText('Platform Settings');
  });

  test('shows Platform Status and Updates sections', async ({ page }) => {
    await expect(page.getByTestId('platform-config-section')).toBeVisible({ timeout: 2000 });
    await expect(page.getByTestId('platform-updates-section')).toBeVisible({ timeout: 2000 });
  });

  test('shows all settings link cards', async ({ page }) => {
    await expect(page.getByTestId('oidc-settings-link')).toBeVisible();
    await expect(page.getByTestId('dns-settings-link')).toBeVisible();
    await expect(page.getByTestId('plan-settings-link')).toBeVisible();
    await expect(page.getByTestId('email-settings-link')).toBeVisible();
    await expect(page.getByTestId('backup-settings-link')).toBeVisible();
    await expect(page.getByTestId('admin-users-link')).toBeVisible();
    await expect(page.getByTestId('health-settings-link')).toBeVisible();
    await expect(page.getByTestId('export-import-link')).toBeVisible();
  });

  test('settings link cards have correct titles', async ({ page }) => {
    await expect(page.getByTestId('oidc-settings-link')).toContainText('OIDC / SSO Configuration');
    await expect(page.getByTestId('dns-settings-link')).toContainText('DNS Servers');
    await expect(page.getByTestId('plan-settings-link')).toContainText('Hosting Plans');
    await expect(page.getByTestId('email-settings-link')).toContainText('Email System');
    await expect(page.getByTestId('backup-settings-link')).toContainText('Backup Configuration');
    await expect(page.getByTestId('admin-users-link')).toContainText('Admin Users');
    await expect(page.getByTestId('health-settings-link')).toContainText('System Health');
    await expect(page.getByTestId('export-import-link')).toContainText('Export / Import');
  });

  test('user menu is accessible and shows profile info', async ({ page }) => {
    const userMenuBtn = page.getByTestId('user-menu-button').or(page.getByLabel('User menu'));
    await expect(userMenuBtn).toBeVisible();
    await userMenuBtn.click();
    // Scope to the dropdown — there's also a mailto:admin footer link that
    // would cause strict-mode ambiguity if we queried by bare text.
    const dropdown = page.getByTestId('user-menu-dropdown');
    await expect(dropdown.getByTestId('user-menu-email')).toContainText('admin@k8s-platform.test');
    await expect(dropdown.getByTestId('user-menu-sign-out')).toBeVisible();
  });
});
