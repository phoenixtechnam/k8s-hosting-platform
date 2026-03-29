import { test, expect } from '@playwright/test';
import { loginAsAdminClient } from './helpers';

test.describe('Client Panel Email Page', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminClient(page);
    await page.getByRole('link', { name: 'Email' }).click();
    await expect(page.getByTestId('email-heading')).toBeVisible({ timeout: 2000 });
  });

  test('page loads with correct heading', async ({ page }) => {
    await expect(page.getByTestId('email-heading')).toHaveText('Email');
  });

  test('shows Email Not Enabled when no email domains configured', async ({ page }) => {
    // On fresh DB with no email-enabled domains, should show not-enabled state
    await expect(page.getByTestId('email-not-enabled')).toBeVisible({ timeout: 2000 });
    await expect(page.getByText('Email Not Enabled')).toBeVisible();
  });

  test('shows contact admin message in not-enabled state', async ({ page }) => {
    await expect(page.getByTestId('email-not-enabled')).toBeVisible({ timeout: 2000 });
    await expect(page.getByText(/contact your administrator/i)).toBeVisible();
  });
});
