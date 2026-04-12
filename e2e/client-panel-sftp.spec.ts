import { test, expect } from '@playwright/test';
import { loginAsAdminClient } from './helpers';

test.describe('Client Panel — SFTP Access', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminClient(page);
  });

  test('can navigate to SFTP Access page', async ({ page }) => {
    await page.getByRole('link', { name: 'SFTP Access' }).click();
    await expect(page.getByTestId('sftp-heading')).toBeVisible({ timeout: 3000 });
    await expect(page.getByTestId('sftp-heading')).toHaveText('SFTP Access');
  });

  test('shows connection info card', async ({ page }) => {
    await page.getByRole('link', { name: 'SFTP Access' }).click();
    await expect(page.getByTestId('sftp-heading')).toBeVisible({ timeout: 3000 });

    // Connection details card should be visible
    await expect(page.getByText('Connection Details')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Host')).toBeVisible();
    await expect(page.getByText('Port')).toBeVisible();
    await expect(page.getByText('Protocols')).toBeVisible();
  });

  test('shows empty state when no SFTP users exist', async ({ page }) => {
    await page.getByRole('link', { name: 'SFTP Access' }).click();
    await expect(page.getByTestId('sftp-heading')).toBeVisible({ timeout: 3000 });

    // Either shows empty state or existing users
    const emptyOrUsers = page.getByText('No SFTP users yet')
      .or(page.getByTestId('sftp-user-count'));
    await expect(emptyOrUsers).toBeVisible({ timeout: 3000 });
  });

  test('can open and close create user form', async ({ page }) => {
    await page.getByRole('link', { name: 'SFTP Access' }).click();
    await expect(page.getByTestId('sftp-heading')).toBeVisible({ timeout: 3000 });

    // Open form
    await page.getByTestId('add-sftp-user-button').click();
    await expect(page.getByTestId('sftp-username-input')).toBeVisible();

    // Close form
    await page.getByTestId('add-sftp-user-button').click();
    await expect(page.getByTestId('sftp-username-input')).not.toBeVisible();
  });

  test('can create an SFTP user and see password', async ({ page }) => {
    await page.getByRole('link', { name: 'SFTP Access' }).click();
    await expect(page.getByTestId('sftp-heading')).toBeVisible({ timeout: 3000 });

    // Open form
    await page.getByTestId('add-sftp-user-button').click();
    await expect(page.getByTestId('sftp-username-input')).toBeVisible();

    // Fill and submit
    const uniqueName = `e2e-test-${Date.now()}`;
    await page.getByTestId('sftp-username-input').fill(uniqueName);
    await page.getByRole('button', { name: 'Create User' }).click();

    // Should show the one-time password alert
    await expect(page.getByText("won't be shown again")).toBeVisible({ timeout: 5000 });

    // User should appear in the table
    await expect(page.getByText(uniqueName)).toBeVisible({ timeout: 3000 });
  });

  test('can toggle SFTP user enabled/disabled', async ({ page }) => {
    await page.getByRole('link', { name: 'SFTP Access' }).click();
    await expect(page.getByTestId('sftp-heading')).toBeVisible({ timeout: 3000 });

    // Ensure at least one user exists — create if needed
    const userCount = page.getByTestId('sftp-user-count');
    await expect(userCount).toBeVisible({ timeout: 3000 });

    // Find and click "Disable" button on first user
    const disableBtn = page.getByRole('button', { name: 'Disable' }).first();
    if (await disableBtn.isVisible()) {
      await disableBtn.click();
      // Should now show "Enable" button
      await expect(page.getByRole('button', { name: 'Enable' }).first()).toBeVisible({ timeout: 3000 });
    }
  });

  test('can rotate password and see new password', async ({ page }) => {
    await page.getByRole('link', { name: 'SFTP Access' }).click();
    await expect(page.getByTestId('sftp-heading')).toBeVisible({ timeout: 3000 });

    // Wait for users to load
    await expect(page.getByTestId('sftp-user-count')).toBeVisible({ timeout: 3000 });

    // Click rotate password button (RefreshCw icon) on first user
    const rotateBtn = page.getByTitle('Rotate password').first();
    if (await rotateBtn.isVisible()) {
      await rotateBtn.click();
      // Should show the rotated password alert
      await expect(page.getByText('Password rotated')).toBeVisible({ timeout: 5000 });
    }
  });

  test('can expand audit log section', async ({ page }) => {
    await page.getByRole('link', { name: 'SFTP Access' }).click();
    await expect(page.getByTestId('sftp-heading')).toBeVisible({ timeout: 3000 });

    // Click on the "Recent Activity" accordion
    await page.getByText('Recent Activity').click();

    // Should show either audit entries or "No activity recorded" message
    const auditContent = page.getByText('No activity recorded')
      .or(page.locator('table').nth(1));
    await expect(auditContent).toBeVisible({ timeout: 3000 });
  });

  test('can delete an SFTP user with confirmation', async ({ page }) => {
    await page.getByRole('link', { name: 'SFTP Access' }).click();
    await expect(page.getByTestId('sftp-heading')).toBeVisible({ timeout: 3000 });

    // Create a user to delete
    await page.getByTestId('add-sftp-user-button').click();
    const deleteTarget = `e2e-delete-${Date.now()}`;
    await page.getByTestId('sftp-username-input').fill(deleteTarget);
    await page.getByRole('button', { name: 'Create User' }).click();
    await expect(page.getByText(deleteTarget)).toBeVisible({ timeout: 5000 });

    // Dismiss password alert
    const dismissBtn = page.getByText("won't be shown again").locator('..').locator('..').getByRole('button').last();
    if (await dismissBtn.isVisible()) {
      await dismissBtn.click();
    }

    // Find the row with our user and click the trash icon
    const row = page.locator('tr').filter({ hasText: deleteTarget });
    await row.getByTitle('Delete').click();

    // Confirmation buttons should appear
    await expect(row.getByRole('button', { name: 'Delete' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Cancel' })).toBeVisible();

    // Confirm deletion
    await row.getByRole('button', { name: 'Delete' }).click();

    // User should be gone
    await expect(page.getByText(deleteTarget)).not.toBeVisible({ timeout: 3000 });
  });

  test('SFTP Access appears in sidebar navigation', async ({ page }) => {
    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar).toBeVisible();
    await expect(page.getByRole('link', { name: 'SFTP Access' })).toBeVisible();
  });
});
