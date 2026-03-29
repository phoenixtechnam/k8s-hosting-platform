import { test, expect } from '@playwright/test';
import { injectAdminAuth } from './helpers';

test.describe('Admin Domains Page', () => {
  test.beforeEach(async ({ page }) => {
    await injectAdminAuth(page);
    await page.getByRole('link', { name: 'Domains' }).click();
    await expect(page.getByRole('heading', { name: 'Domains' })).toBeVisible({ timeout: 2000 });
  });

  test('domains page loads with heading and Add Domain button', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Domains' })).toBeVisible();
    await expect(page.getByTestId('add-domain-button')).toBeVisible();
    await expect(page.getByTestId('add-domain-button')).toBeEnabled();
  });

  test('search input is present', async ({ page }) => {
    await expect(page.getByTestId('domain-search')).toBeVisible();
  });

  test('shows domains table with expected column headers', async ({ page }) => {
    const table = page.getByTestId('domains-table');
    await expect(table).toBeVisible({ timeout: 2000 });

    // Verify key column headers exist in the table
    await expect(table.locator('th', { hasText: 'Domain Name' })).toBeVisible();
    await expect(table.locator('th', { hasText: 'Client' })).toBeVisible();
    await expect(table.locator('th', { hasText: 'Status' })).toBeVisible();
  });

  test('shows empty state or domains on fresh DB', async ({ page }) => {
    await expect(page.getByTestId('domains-table')).toBeVisible({ timeout: 2000 });

    // On a fresh DB, either domains exist or we see empty message
    const emptyMsg = page.locator('text=No domains');
    const domainRow = page.locator('[data-testid^="domain-row-"]').first();

    const hasEmpty = await emptyMsg.isVisible().catch(() => false);
    const hasRows = await domainRow.isVisible().catch(() => false);

    expect(hasEmpty || hasRows).toBe(true);
  });
});
