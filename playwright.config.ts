import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 2,
  workers: 3,
  use: {
    headless: true,
  },
  projects: [
    {
      name: 'admin',
      use: {
        browserName: 'chromium',
        baseURL: process.env.BASE_URL ?? 'http://dind.local:2010',
      },
      testIgnore: '**/client-panel-*',
    },
    {
      name: 'client',
      use: {
        browserName: 'chromium',
        baseURL: process.env.CLIENT_URL ?? 'http://dind.local:2011',
      },
      testMatch: '**/client-panel-*',
    },
  ],
});
