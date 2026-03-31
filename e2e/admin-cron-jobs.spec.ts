import { test, expect } from '@playwright/test';
import { injectAdminAuth } from './helpers';

test.describe('Admin Cron Jobs Page', () => {
  test.beforeEach(async ({ page }) => { await injectAdminAuth(page); });
  test.beforeEach(async ({ page }) => {
    await page.goto('/cron-jobs');
    await expect(page.getByRole('heading', { name: 'Cron Jobs' })).toBeVisible({ timeout: 2000 });
  });

  test('cron jobs page loads', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Cron Jobs' })).toBeVisible();
  });

  test('shows client selector', async ({ page }) => {
    const selector = page.getByTestId('client-search-select');
    await expect(selector).toBeVisible();
  });

  test('shows Add Cron Job button', async ({ page }) => {
    const addButton = page.getByTestId('add-cron-job-button');
    await expect(addButton).toBeVisible();
    await expect(addButton).toContainText('Add Cron Job');
  });

  test('add cron job button is disabled when no client selected', async ({ page }) => {
    const addButton = page.getByTestId('add-cron-job-button');
    await expect(addButton).toBeDisabled();
  });

  test('shows select client prompt when no client selected', async ({ page }) => {
    // When no client is selected, the table shows "No cron jobs found across any client."
    await expect(page.getByText('No cron jobs found across any client.')).toBeVisible({ timeout: 2000 });
  });
});
