import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

test.describe('Admin Security Page', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.getByRole('link', { name: 'Security' }).click();
    await expect(page.getByRole('heading', { name: 'Security', exact: true })).toBeVisible({ timeout: 5000 });
  });

  test('security page loads', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Security', exact: true })).toBeVisible();
  });

  test('shows stat cards', async ({ page }) => {
    const cards = page.locator('[data-testid="stat-card"]');
    await expect(cards.first()).toBeVisible({ timeout: 5000 });
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('shows Network Policies section', async ({ page }) => {
    await expect(page.getByText('Network Policies').first()).toBeVisible({ timeout: 5000 });
  });

  test('shows Security Events section', async ({ page }) => {
    await expect(page.getByText('Security Events').first()).toBeVisible({ timeout: 5000 });
  });

  test('displays security score value', async ({ page }) => {
    await expect(page.getByText('92/100')).toBeVisible({ timeout: 5000 });
  });
});
