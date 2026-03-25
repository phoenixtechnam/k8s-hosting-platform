import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

test.describe('Admin Settings Page', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByTestId('settings-heading')).toBeVisible({ timeout: 5000 });
  });

  test('settings page loads', async ({ page }) => {
    await expect(page.getByTestId('settings-heading')).toHaveText('Settings');
  });

  test('shows Profile section with user info', async ({ page }) => {
    const profileSection = page.getByTestId('profile-section');
    await expect(profileSection).toBeVisible();

    // Profile should display user details
    await expect(page.getByTestId('profile-email')).toBeVisible();
    await expect(page.getByTestId('profile-role')).toBeVisible();
  });

  test('shows Platform Configuration section', async ({ page }) => {
    const configSection = page.getByTestId('platform-config-section');
    await expect(configSection).toBeVisible();

    await expect(page.getByText('Platform Name')).toBeVisible();
    await expect(page.getByText('K8s Hosting Platform')).toBeVisible();
    await expect(page.getByText('Version')).toBeVisible();
  });

  test('shows Change Password form', async ({ page }) => {
    const passwordSection = page.getByTestId('change-password-section');
    await expect(passwordSection).toBeVisible();
    await expect(page.getByText('Change Password')).toBeVisible();
  });

  test('password form has current, new, and confirm fields', async ({ page }) => {
    await expect(page.getByTestId('current-password-input')).toBeVisible();
    await expect(page.getByTestId('new-password-input')).toBeVisible();
    await expect(page.getByTestId('confirm-password-input')).toBeVisible();
    await expect(page.getByTestId('update-password-button')).toBeVisible();
  });

  test('profile shows admin email', async ({ page }) => {
    const profileEmail = page.getByTestId('profile-email');
    await expect(profileEmail).toContainText('admin@platform.local');
  });
});
