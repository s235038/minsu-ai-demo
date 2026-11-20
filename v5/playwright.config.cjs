const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './browser',
  // Two independent browser sessions and a local server can exceed 30s on cold CI runners.
  timeout: 60_000,
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop Chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile WebKit', use: { ...devices['iPhone 13'], viewport: { width: 360, height: 740 } } },
  ],
});
