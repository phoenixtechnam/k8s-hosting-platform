import { Page, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

export async function loginAsAdmin(page: Page) {
  await page.goto('/login');
  await page.evaluate(() => { localStorage.clear(); });
  await page.goto('/login');
  await page.waitForLoadState('networkidle');

  await page.getByTestId('email-input').fill('admin@platform.local');
  await page.getByTestId('password-input').fill('admin');
  await page.getByTestId('login-button').click();

  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible({ timeout: 5000 });
}

export async function injectAdminAuth(page: Page) {
  const authPath = path.join(__dirname, '.auth/admin-auth.json');
  if (!fs.existsSync(authPath)) {
    // Fallback to full login if setup hasn't run
    await loginAsAdmin(page);
    return;
  }

  const authData = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
  await page.goto('/login');
  await page.evaluate((data) => {
    if (data.token) localStorage.setItem('auth_token', data.token);
    if (data.user) localStorage.setItem('auth_user', data.user);
  }, authData);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible({ timeout: 5000 });
}

export async function loginAsAdminClient(page: Page) {
  await page.goto('/login');
  await page.evaluate(() => { localStorage.clear(); });
  await page.goto('/login');
  await page.waitForLoadState('networkidle');

  await page.getByTestId('email-input').fill('admin@platform.local');
  await page.getByTestId('password-input').fill('admin');
  await page.getByTestId('login-button').click();

  await expect(page.getByTestId('welcome-heading')).toBeVisible({ timeout: 5000 });
}
