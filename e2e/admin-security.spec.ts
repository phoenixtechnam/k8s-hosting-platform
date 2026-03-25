import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

test.describe('Admin Security Page', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.getByRole('link', { name: 'Security' }).click();
    await expect(page.getByRole('heading', { name: 'Security' })).toBeVisible({ timeout: 5000 });
  });

  test('security page loads', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Security' })).toBeVisible();
  });

  test('shows stat cards', async ({ page }) => {
    await expect(page.getByText('Network Policies')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Sealed Secrets')).toBeVisible();
    await expect(page.getByText('SSL Certificates')).toBeVisible();
    await expect(page.getByText('Security Score')).toBeVisible();
  });

  test('shows Network Policies section', async ({ page }) => {
    const policiesTable = page.getByTestId('policies-table');
    await expect(policiesTable).toBeVisible({ timeout: 5000 });

    // Verify at least one known policy from the static data
    await expect(page.getByText('deny-all-ingress')).toBeVisible();
  });

  test('shows Security Events section', async ({ page }) => {
    const eventsTable = page.getByTestId('events-table');
    await expect(eventsTable).toBeVisible({ timeout: 5000 });

    // Verify at least one known event from the static data
    await expect(page.getByText('Failed login attempt blocked')).toBeVisible();
  });

  test('displays security score value', async ({ page }) => {
    await expect(page.getByText('92/100')).toBeVisible({ timeout: 5000 });
  });
});
