import { defineConfig, devices } from '@playwright/test';

// Chromium is preinstalled in Claude Code web sessions via
// PLAYWRIGHT_BROWSERS_PATH; never run `playwright install` there.
//
// Which is why @playwright/test is pinned to ~1.56 in package.json rather
// than floated: every Playwright release demands one exact Chromium
// revision, and 1.56 is the release that asks for the preinstalled 1194. A
// wider range resolves to something newer, which then refuses to launch
// because it wants a browser this image does not have.
export default defineConfig({
  testDir: './test',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'list' : 'html',
  use: {
    baseURL: 'http://localhost:8080',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'node scripts/serve.mjs',
    url: 'http://localhost:8080',
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
  },
});
