import { Page, expect } from '@playwright/test';

export async function loginAsAdmin(page: Page) {
  await page.goto('/login');
  await page.getByTestId('email-input').fill('admin@platform.local');
  await page.getByTestId('password-input').fill('admin');
  await page.getByTestId('login-button').click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 10000 });
}

export async function loginAsAdminClient(page: Page) {
  await page.goto('/login');
  await page.getByTestId('email-input').fill('admin@platform.local');
  await page.getByTestId('password-input').fill('admin');
  await page.getByTestId('login-button').click();
  await expect(page.getByTestId('welcome-heading')).toBeVisible({ timeout: 15000 });
}
