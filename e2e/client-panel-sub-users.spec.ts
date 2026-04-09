import { test, expect } from '@playwright/test';
import { loginAsAdminClient } from './helpers';

test.describe('Client Panel Sub-Users', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminClient(page);
    // The route is /users but the sidebar link text may vary
    await page.goto('/users');
    await expect(page.getByTestId('sub-users-heading')).toBeVisible({ timeout: 5000 });
  });

  test('users page loads with heading', async ({ page }) => {
    await expect(page.getByTestId('sub-users-heading')).toHaveText('Users');
  });

  test('shows Add User button', async ({ page }) => {
    await expect(page.getByTestId('add-user-button')).toBeVisible();
  });

  test('shows users table or empty state', async ({ page }) => {
    // Phase 1: we explicitly do NOT accept "Failed to load users" here.
    // That error state was masking the plugin-wide requireRole regression
    // in clients/routes.ts that locked every client_admin out of GET
    // /clients/:id/users. The fix is tested by asserting the success
    // paths only: the table renders OR the empty state renders.
    const content = page
      .getByTestId('users-table')
      .or(page.getByText('No sub-users yet'));
    await expect(content).toBeVisible({ timeout: 10000 });
    // Explicit anti-regression: the error banner must NOT be visible.
    await expect(page.getByText('Failed to load users.')).not.toBeVisible();
  });

  test('read-only notice is not shown for impersonated client_admin', async ({ page }) => {
    // The E2E helper always impersonates as client_admin, so the
    // Phase 1 read-only notice should NOT appear.
    await expect(page.getByTestId('read-only-notice')).not.toBeVisible();
  });
});
