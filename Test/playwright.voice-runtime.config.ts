import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./specs",
  testMatch: /voice-runtime\.spec\.ts/,
  timeout: 10 * 60_000,
  expect: {
    timeout: 30_000
  },
  fullyParallel: false,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "./playwright-report/voice-runtime", open: "never" }]
  ],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  outputDir: "./test-results/voice-runtime"
});
