import { defineConfig, devices } from "@playwright/test";

const testPort = Number.parseInt(process.env.LING_PLAYWRIGHT_PORT ?? "4174", 10);
const testBaseUrl = `http://127.0.0.1:${testPort}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  // The mock daemon suite was originally one large spec, which made execution
  // effectively serial. Keep that contract after splitting files so browser
  // storage, route mocks, and Vite app state do not race across domains.
  workers: 1,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL: testBaseUrl,
    locale: "en-US",
    trace: "on-first-retry",
  },
  webServer: {
    command: `corepack pnpm exec vite --host 127.0.0.1 --port ${testPort} --strictPort`,
    url: testBaseUrl,
    reuseExistingServer: process.env.LING_PLAYWRIGHT_REUSE_SERVER !== "0",
    timeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 960 } },
    },
  ],
});
