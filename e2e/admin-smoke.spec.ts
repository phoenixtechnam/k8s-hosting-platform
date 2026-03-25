import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

test.describe('Admin Panel Smoke Test', () => {
  test('login page loads', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByText('K8s Hosting Platform')).toBeVisible();
    await expect(page.getByTestId('email-input')).toBeVisible();
    await expect(page.getByTestId('password-input')).toBeVisible();
  });

  test('can login with admin credentials', async ({ page }) => {
    await loginAsAdmin(page);
  });

  test('dashboard shows stat cards', async ({ page }) => {
    await loginAsAdmin(page);

    // Check stat cards
    await expect(page.getByText('Total Clients')).toBeVisible();
    await expect(page.getByText('Databases')).toBeVisible();
  });

  test('can navigate to clients page', async ({ page }) => {
    await loginAsAdmin(page);

    // Navigate to clients
    await page.getByRole('link', { name: 'Clients' }).click();
    await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add Client' })).toBeVisible();
  });

  test('can create a client', async ({ page }) => {
    await loginAsAdmin(page);

    // Go to clients
    await page.getByRole('link', { name: 'Clients' }).click();
    await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible();

    // Click Add Client
    await page.getByText('Add Client').click();
    await expect(page.getByTestId('create-client-modal')).toBeVisible();

    // Fill form with unique name
    const uniqueName = `E2E Corp ${Date.now()}`;
    await page.getByTestId('company-name-input').fill(uniqueName);
    await page.getByTestId('company-email-input').fill('test@e2e.local');

    // Select plan and region (first option)
    await page.getByTestId('plan-select').selectOption({ index: 1 });
    await page.getByTestId('region-select').selectOption({ index: 1 });

    // Submit
    await page.getByTestId('submit-button').click();

    // Modal should close and client should appear in list
    await expect(page.getByTestId('create-client-modal')).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByText(uniqueName)).toBeVisible({ timeout: 5000 });
  });

  test('sidebar navigation works', async ({ page }) => {
    await loginAsAdmin(page);

    // Test each nav item
    for (const item of ['Domains', 'Workloads', 'Monitoring', 'Settings']) {
      await page.getByRole('link', { name: item }).click();
      await expect(page.getByRole('heading', { name: item })).toBeVisible();
    }
  });
});
