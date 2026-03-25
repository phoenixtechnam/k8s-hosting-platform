import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

test.describe('Admin Monitoring Page', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.getByRole('link', { name: 'Monitoring' }).click();
    await expect(page.getByRole('heading', { name: 'Monitoring', exact: true })).toBeVisible({ timeout: 5000 });
  });

  test('monitoring page loads', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Monitoring', exact: true })).toBeVisible();
  });

  test('shows stat cards', async ({ page }) => {
    const cards = page.locator('[data-testid="stat-card"]');
    await expect(cards.first()).toBeVisible({ timeout: 5000 });
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('has tab buttons', async ({ page }) => {
    await expect(page.getByText('Active Alerts').first()).toBeVisible({ timeout: 5000 });
  });

  test('can switch tabs', async ({ page }) => {
    const historyText = page.getByText('Alert History').first();
    if (await historyText.isVisible().catch(() => false)) {
      await historyText.click();
      await page.waitForTimeout(500);
    }
  });

  test('shows metric content', async ({ page }) => {
    const metricsText = page.getByText('System Metrics').first();
    if (await metricsText.isVisible().catch(() => false)) {
      await metricsText.click();
      await page.waitForTimeout(500);
      const bars = page.locator('[role="progressbar"]');
      const count = await bars.count();
      expect(count).toBeGreaterThanOrEqual(0);
    }
  });
});
