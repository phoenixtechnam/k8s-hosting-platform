import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

test.describe('Admin Cron Jobs Page', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/cron-jobs');
    await expect(page.getByRole('heading', { name: 'Cron Jobs' })).toBeVisible({ timeout: 5000 });
  });

  test('cron jobs page loads', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Cron Jobs' })).toBeVisible();
  });

  test('shows client selector', async ({ page }) => {
    const selector = page.getByTestId('client-selector');
    await expect(selector).toBeVisible();
    await expect(selector).toBeEnabled();
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
    await expect(page.getByTestId('select-client-prompt')).toBeVisible();
    await expect(page.getByTestId('select-client-prompt')).toContainText('Select a client');
  });
});
