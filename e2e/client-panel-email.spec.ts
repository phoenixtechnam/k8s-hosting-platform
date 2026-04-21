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

  test('shows enable-email card when no email domains configured', async ({ page }) => {
    // New UX: when no email-enabled domains exist the page shows a self-serve
    // enable-email card (old "Email Not Enabled / contact admin" message
    // was removed; clients can turn email on themselves).
    await expect(page.getByTestId('email-enable-card')).toBeVisible({ timeout: 2000 });
  });

  test('enable-email card describes what will happen', async ({ page }) => {
    await expect(page.getByTestId('email-enable-card')).toBeVisible({ timeout: 2000 });
    await expect(page.getByText(/Enable Email Hosting|Enable Email for another domain/)).toBeVisible();
  });
});
