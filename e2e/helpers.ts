import { Page, expect } from '@playwright/test';

export async function loginAsAdmin(page: Page) {
  // Clear any stale auth state
  await page.goto('/login');
  await page.evaluate(() => {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
  });
  await page.goto('/login');
  await page.waitForLoadState('networkidle');

  // Wait for login form to appear (may take a moment for OIDC status fetch)
  const emailInput = page.getByTestId('email-input');
  await expect(emailInput).toBeVisible({ timeout: 10000 });

  // Fill and submit
  await emailInput.fill('admin@platform.local');
  await page.getByTestId('password-input').fill('admin');
  await page.getByTestId('login-button').click();

  // Wait for navigation to dashboard (use heading to avoid sidebar ambiguity)
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible({ timeout: 15000 });
}

export async function loginAsAdminClient(page: Page) {
  // Clear stale state
  await page.goto('/login');
  await page.evaluate(() => {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
  });
  await page.goto('/login');
  await page.waitForLoadState('networkidle');

  const emailInput = page.getByTestId('email-input');
  await expect(emailInput).toBeVisible({ timeout: 10000 });

  await emailInput.fill('admin@platform.local');
  await page.getByTestId('password-input').fill('admin');
  await page.getByTestId('login-button').click();

  await expect(page.getByTestId('welcome-heading')).toBeVisible({ timeout: 15000 });
}
