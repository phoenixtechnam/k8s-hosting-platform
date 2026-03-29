import { test, expect } from '@playwright/test';
import { injectAdminAuth } from './helpers';

test.describe('Admin Email Management Page', () => {
  test.beforeEach(async ({ page }) => {
    await injectAdminAuth(page);
    await page.goto('/settings/email');
    await expect(page.getByTestId('email-mgmt-heading')).toBeVisible({ timeout: 2000 });
  });

  test('page loads with correct heading', async ({ page }) => {
    await expect(page.getByTestId('email-mgmt-heading')).toHaveText('Email Management');
  });

  test('shows stat cards for email metrics', async ({ page }) => {
    // Use locators scoped to avoid strict mode issues — stat cards have titles
    await expect(page.locator('text=Email Domains').first()).toBeVisible();
    await expect(page.locator('text=Total Mailboxes').first()).toBeVisible();
    await expect(page.locator('text=DKIM Configured').first()).toBeVisible();
    await expect(page.locator('text=Mail Server').first()).toBeVisible();
  });

  test('has Email Domains and SMTP Relays tabs', async ({ page }) => {
    await expect(page.getByTestId('tab-domains')).toBeVisible();
    await expect(page.getByTestId('tab-domains')).toHaveText('Email Domains');
    await expect(page.getByTestId('tab-relays')).toBeVisible();
    await expect(page.getByTestId('tab-relays')).toHaveText('SMTP Relays');
  });

  test('Email Domains tab shows domains table', async ({ page }) => {
    await expect(page.getByTestId('email-domains-table')).toBeVisible({ timeout: 2000 });
  });

  test('SMTP Relays tab shows Add SMTP Relay button and empty state', async ({ page }) => {
    await page.getByTestId('tab-relays').click();
    await expect(page.getByTestId('add-relay-button')).toBeVisible({ timeout: 2000 });
    await expect(page.getByTestId('add-relay-button')).toContainText('Add SMTP Relay');
    // Fresh DB — no relays
    await expect(page.getByText('No SMTP relays configured')).toBeVisible({ timeout: 2000 });
  });

  test('can switch between tabs', async ({ page }) => {
    await expect(page.getByTestId('email-domains-table')).toBeVisible({ timeout: 2000 });
    await page.getByTestId('tab-relays').click();
    await expect(page.getByTestId('add-relay-button')).toBeVisible({ timeout: 2000 });
    await page.getByTestId('tab-domains').click();
    await expect(page.getByTestId('email-domains-table')).toBeVisible({ timeout: 2000 });
  });
});
