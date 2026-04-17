import { test, expect } from '@playwright/test';
import { injectAdminAuth } from './helpers';

test.describe('Admin Users Management', () => {
  test.beforeEach(async ({ page }) => {
    await injectAdminAuth(page);
    await page.goto('/settings/users');
    await expect(page.getByTestId('admin-users-heading')).toBeVisible({ timeout: 3000 });
  });

  test('admin users page loads with heading', async ({ page }) => {
    await expect(page.getByTestId('admin-users-heading')).toHaveText('Admin Users');
  });

  test('shows Add Admin User button', async ({ page }) => {
    await expect(page.getByTestId('add-admin-user-button')).toBeVisible();
  });

  test('shows user table with at least the current admin', async ({ page }) => {
    // There should always be at least one admin user (the logged-in user)
    await expect(page.getByText('admin@k8s-platform.test')).toBeVisible({ timeout: 2000 });
  });
});
