import { test as setup } from '@playwright/test';

// Login once and save the token + user for other tests to inject via localStorage
setup('authenticate as admin', async ({ page }) => {
  await page.goto('/login');
  await page.evaluate(() => { localStorage.clear(); });
  await page.goto('/login');
  await page.waitForLoadState('networkidle');

  await page.getByTestId('email-input').fill('admin@k8s-platform.test');
  await page.getByTestId('password-input').fill('admin');
  await page.getByTestId('login-button').click();
  await page.waitForURL('**/');
  await page.waitForTimeout(1000);

  // Extract token and user from localStorage
  const authData = await page.evaluate(() => ({
    token: localStorage.getItem('auth_token'),
    user: localStorage.getItem('auth_user'),
  }));

  // Save as storageState with localStorage injected via cookies workaround
  // Actually, save to a JSON file that other tests read
  const fs = await import('fs');
  fs.mkdirSync('e2e/.auth', { recursive: true });
  fs.writeFileSync('e2e/.auth/admin-auth.json', JSON.stringify(authData));

  // Also save storageState for cookie-based checks
  await page.context().storageState({ path: 'e2e/.auth/admin.json' });
});
