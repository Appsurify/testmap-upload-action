import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests',
  reporter: [['list'], ['@appsurify-testmap/rrweb-playwright-plugin/reporter']],
  use: { baseURL: 'http://localhost:4173' },
  webServer: { command: 'python3 -m http.server 4173 --directory site', url: 'http://localhost:4173', reuseExistingServer: true },
});
