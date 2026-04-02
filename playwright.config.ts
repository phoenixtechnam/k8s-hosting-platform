import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 10_000,
  retries: 1,
  workers: 3,
  use: {
    headless: true,
    actionTimeout: 2_000,
    navigationTimeout: 5_000,
  },
  expect: {
    timeout: 2_000,
  },
  projects: [
    {
      name: 'admin-setup',
      testMatch: 'auth.setup.ts',
      use: {
        browserName: 'chromium',
        baseURL: process.env.BASE_URL ?? 'http://dind.local:2010',
      },
    },
    {
      name: 'admin',
      dependencies: ['admin-setup'],
      use: {
        browserName: 'chromium',
        baseURL: process.env.BASE_URL ?? 'http://dind.local:2010',
        storageState: 'e2e/.auth/admin.json',
      },
      testIgnore: ['**/client-panel-*', '**/auth.setup.ts'],
    },
    {
      name: 'client',
      dependencies: ['admin-setup'],
      use: {
        browserName: 'chromium',
        baseURL: process.env.CLIENT_URL ?? 'http://dind.local:2011',
      },
      testMatch: '**/client-panel-*',
    },
  ],
});
