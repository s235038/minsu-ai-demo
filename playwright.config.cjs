const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  projects: [
    { name: 'mobile WebKit', use: { ...devices['iPhone 13'] } },
    { name: 'desktop Chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  use: { baseURL: 'http://127.0.0.1:8713' },
  webServer: {
    command: 'python3 -m http.server 8713 --bind 127.0.0.1',
    url: 'http://127.0.0.1:8713/minsu_ai_v3.html',
  },
});
