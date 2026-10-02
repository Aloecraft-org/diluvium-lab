import { defineConfig, devices } from '@playwright/test';

// The lab inside DiRT Launcher: `test/launcher/` drives the launcher's dev
// server with this repo plugged in as ../diluvium-lab. The launcher is
// expected beside this checkout (README: In DiRT Launcher). `DIRT_SET` picks
// the plugin set; `core` is the launcher's full set, `lab` the smallest one
// that carries the lab.
const SET = process.env.DIRT_SET ?? 'core';
const PORT = 5199;

export default defineConfig({
  testDir: './test/launcher',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'list' : 'html',
  timeout: 90_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: `cd ../dirt-launcher && DIRT_SET=${SET} npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
  },
});
