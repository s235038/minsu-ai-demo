const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './browser',
  projects: [
    { name: 'desktop Chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile WebKit', use: { ...devices['iPhone 13'], viewport: { width: 360, height: 740 } } },
  ],
});
