import { test, expect } from '@playwright/test';
import { injectAdminAuth } from './helpers';

test.describe('Admin Settings Page', () => {
  test.beforeEach(async ({ page }) => {
    await injectAdminAuth(page);
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: /Settings/i })).toBeVisible({ timeout: 2000 });
  });

  test('settings page loads', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /Settings/i })).toBeVisible();
  });

  test('shows Platform Status section', async ({ page }) => {
    await expect(page.getByText('Platform Status')).toBeVisible({ timeout: 2000 });
  });

  test('shows Platform Updates section', async ({ page }) => {
    await expect(page.getByTestId('platform-updates-section')).toBeVisible({ timeout: 2000 });
  });

  test('user menu is accessible from header', async ({ page }) => {
    const userMenuBtn = page.getByTestId('user-menu-button').or(page.getByLabel('User menu'));
    await expect(userMenuBtn).toBeVisible();
  });

  test('user menu shows profile info', async ({ page }) => {
    const userMenuBtn = page.getByTestId('user-menu-button').or(page.getByLabel('User menu'));
    await userMenuBtn.click();
    await expect(page.getByText('admin@platform.local')).toBeVisible({ timeout: 2000 });
  });

  test('user menu has sign out', async ({ page }) => {
    const userMenuBtn = page.getByTestId('user-menu-button').or(page.getByLabel('User menu'));
    await userMenuBtn.click();
    await expect(page.getByText('Sign Out')).toBeVisible({ timeout: 2000 });
  });
});
