import { Page, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// Backend API isn't publicly exposed — calls go through the admin-panel
// nginx sidecar which reverse-proxies /api/* to platform-api internally.
const API_BASE = process.env.API_URL ?? 'http://admin.k8s-platform.test:2010';

export async function loginAsAdmin(page: Page) {
  await page.goto('/login');
  await page.evaluate(() => { localStorage.clear(); });
  await page.goto('/login');
  await page.waitForLoadState('networkidle');

  await page.getByTestId('email-input').fill('admin@k8s-platform.test');
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

/**
 * Get or create a test client and return impersonation credentials.
 * Uses the admin API to create a client, then impersonates it.
 * Caches the result to e2e/.auth/client-auth.json for reuse across tests.
 */
async function getClientAuth(): Promise<{ token: string; user: string }> {
  const cachePath = path.join(__dirname, '.auth/client-auth.json');
  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    if (cached.token && cached.user) return cached;
  }

  // Get admin token
  const adminAuthPath = path.join(__dirname, '.auth/admin-auth.json');
  let adminToken: string;

  if (fs.existsSync(adminAuthPath)) {
    const adminAuth = JSON.parse(fs.readFileSync(adminAuthPath, 'utf-8'));
    adminToken = adminAuth.token;
  } else {
    // Login as admin to get token
    const loginRes = await fetch(`${API_BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@k8s-platform.test', password: 'admin' }),
    });
    const loginData = await loginRes.json() as { data: { token: string } };
    adminToken = loginData.data.token;
  }

  const headers = {
    'Authorization': `Bearer ${adminToken}`,
    'Content-Type': 'application/json',
  };

  // Check if test client already exists
  const clientsRes = await fetch(`${API_BASE}/api/v1/clients?limit=100`, { headers });
  const clientsData = await clientsRes.json() as { data: { id: string; companyEmail: string }[] };
  let clientId = clientsData.data?.find((c: { companyEmail: string }) => c.companyEmail === 'e2e-test@k8s-platform.test')?.id;

  // Create test client if not exists
  if (!clientId) {
    // Get first available plan and region
    const [plansRes, regionsRes] = await Promise.all([
      fetch(`${API_BASE}/api/v1/plans`, { headers }),
      fetch(`${API_BASE}/api/v1/regions`, { headers }),
    ]);
    const plansData = await plansRes.json() as { data: { id: string }[] };
    const regionsData = await regionsRes.json() as { data: { id: string }[] };
    const planId = plansData.data?.[0]?.id;
    const regionId = regionsData.data?.[0]?.id;

    const createRes = await fetch(`${API_BASE}/api/v1/clients`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        company_name: 'E2E Test Client',
        company_email: 'e2e-test@k8s-platform.test',
        plan_id: planId,
        region_id: regionId,
      }),
    });
    const createData = await createRes.json() as { data: { id: string } };
    if (createData.data?.id) {
      clientId = createData.data.id;
    } else {
      // Race condition: another worker created the client — retry search
      await new Promise(r => setTimeout(r, 1000));
      const retryRes = await fetch(`${API_BASE}/api/v1/clients?limit=100`, { headers });
      const retryData = await retryRes.json() as { data: { id: string; companyEmail: string }[] };
      clientId = retryData.data?.find((c: { companyEmail: string }) => c.companyEmail === 'e2e-test@k8s-platform.test')?.id;
      if (!clientId) {
        throw new Error(`Failed to create or find test client: ${JSON.stringify(createData)}`);
      }
    }
  }

  // Impersonate the client to get a client-panel JWT. Client creation is
  // async — the client_admin user is provisioned shortly after the client
  // row, so impersonation can race and return NO_CLIENT_USER. Retry for
  // up to 10s, which comfortably covers the worker's post-create hook.
  let impersonateData: Record<string, unknown> = {};
  for (let i = 0; i < 20; i++) {
    const impersonateRes = await fetch(`${API_BASE}/api/v1/admin/impersonate/${clientId}`, {
      method: 'POST',
      headers: { 'Authorization': headers['Authorization'] },
    });
    impersonateData = await impersonateRes.json() as Record<string, unknown>;
    if (impersonateData.data && (impersonateData.data as Record<string, unknown>).token) break;
    // Only retry the specific "no client_admin yet" error — surface others
    const err = impersonateData.error as { code?: string } | undefined;
    if (err?.code !== 'NO_CLIENT_USER') break;
    await new Promise(r => setTimeout(r, 500));
  }

  if (!impersonateData.data || !(impersonateData.data as Record<string, unknown>).token) {
    throw new Error(`Failed to impersonate client ${clientId}: ${JSON.stringify(impersonateData)}`);
  }

  const impData = impersonateData.data as { token: string; user: Record<string, unknown> };
  const result = {
    token: impData.token,
    user: JSON.stringify(impData.user),
  };

  // Cache for reuse
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(result));

  return result;
}

/**
 * Login to the client panel by injecting an impersonation token.
 * Creates a test client on first call and caches credentials.
 */
export async function loginAsAdminClient(page: Page) {
  const auth = await getClientAuth();

  await page.goto('/login');
  await page.evaluate((data) => {
    localStorage.clear();
    localStorage.setItem('auth_token', data.token);
    localStorage.setItem('auth_user', data.user);
  }, auth);
  await page.goto('/');

  await expect(page.getByTestId('welcome-heading')).toBeVisible({ timeout: 5000 });
}
