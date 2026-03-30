import { test, expect } from '@playwright/test';
import { loginAsAdminClient } from './helpers';

test.describe('Client Panel Sub-Users', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminClient(page);
    // The route is /users but the sidebar link text may vary
    await page.goto('/users');
    await expect(page.getByTestId('sub-users-heading')).toBeVisible({ timeout: 2000 });
  });

  test('users page loads with heading', async ({ page }) => {
    await expect(page.getByTestId('sub-users-heading')).toHaveText('Users');
  });

  test('shows Add User button', async ({ page }) => {
    await expect(page.getByTestId('add-user-button')).toBeVisible();
  });

  test('shows users table or empty state', async ({ page }) => {
    const content = page.getByTestId('users-table')
      .or(page.getByText('No sub-users yet'));
    await expect(content).toBeVisible({ timeout: 2000 });
  });
});
