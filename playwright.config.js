const { defineConfig, devices } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  projects: [
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'] } }
  ],
  workers: process.env.CI ? 4 : 6,
  webServer: { command: 'node tests/serve.cjs', url: 'http://127.0.0.1:4173', reuseExistingServer: !process.env.CI }
});
