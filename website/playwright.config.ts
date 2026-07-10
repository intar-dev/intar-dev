import { defineConfig, devices } from "@playwright/test";

const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./tests/ui",
  fullyParallel: false,
  ...(ci ? { workers: 1 } : {}),
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.001,
      scale: "css",
    },
  },
  outputDir: "../.tmp/website-playwright/test-results",
  reporter: ci
    ? [
        ["line"],
        [
          "html",
          {
            open: "never",
            outputFolder: "../.tmp/website-playwright/playwright-report",
          },
        ],
      ]
    : [
        ["list"],
        [
          "html",
          {
            open: "never",
            outputFolder: "../.tmp/website-playwright/playwright-report",
          },
        ],
      ],
  snapshotPathTemplate:
    "{testDir}/__screenshots__/{testFilePath}/{arg}{ext}",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4330",
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "bun scripts/playwright-dev.ts",
    url: "http://127.0.0.1:4330",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium-ui",
      testIgnore: /smoke\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        browserName: "chromium",
      },
    },
    {
      name: "chromium-smoke",
      testMatch: /smoke\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox-smoke",
      testMatch: /smoke\.spec\.ts/,
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit-smoke",
      testMatch: /smoke\.spec\.ts/,
      use: { ...devices["Desktop Safari"] },
    },
  ],
});
