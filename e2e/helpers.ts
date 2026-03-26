import { Page, expect } from '@playwright/test';

async function attemptLogin(page: Page, email: string, password: string) {
  await page.getByTestId('email-input').fill(email);
  await page.getByTestId('password-input').fill(password);
  await page.getByTestId('login-button').click();
}

export async function loginAsAdmin(page: Page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await page.waitForTimeout(2000);
    }
    await page.goto('/login');
    await page.waitForTimeout(500);
    await attemptLogin(page, 'admin@platform.local', 'admin');

    const dashboard = page.getByRole('heading', { name: 'Dashboard' });
    try {
      await expect(dashboard).toBeVisible({ timeout: 15000 });
      return; // Success
    } catch {
      // Check if we landed on a page with sidebar (logged in but error on dashboard)
      const sidebar = page.locator('nav[aria-label="Main"]');
      if (await sidebar.isVisible().catch(() => false)) {
        // We're logged in, just dashboard had a transient error — navigate to dashboard
        await page.goto('/');
        try {
          await expect(dashboard).toBeVisible({ timeout: 10000 });
          return; // Success on retry
        } catch {
          // Continue to next attempt
        }
      }
      if (attempt === 2) throw new Error('Login failed after 3 attempts');
    }
  }
}

export async function loginAsAdminClient(page: Page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await page.waitForTimeout(2000);
    }
    await page.goto('/login');
    await page.waitForTimeout(500);
    await attemptLogin(page, 'admin@platform.local', 'admin');

    const welcome = page.getByTestId('welcome-heading');
    try {
      await expect(welcome).toBeVisible({ timeout: 15000 });
      return; // Success
    } catch {
      const sidebar = page.locator('nav[aria-label="Main"]');
      if (await sidebar.isVisible().catch(() => false)) {
        await page.goto('/');
        try {
          await expect(welcome).toBeVisible({ timeout: 10000 });
          return;
        } catch {
          // Continue to next attempt
        }
      }
      if (attempt === 2) throw new Error('Login failed after 3 attempts');
    }
  }
}
