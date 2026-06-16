import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/ui",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "on-first-retry",
  },
  webServer: {
    command:
      "rm -rf .playwright && mkdir -p .playwright && npm run db:migrate && npm run db:seed && npm run dev -- --hostname 127.0.0.1 --port 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      LOOPBOARD_DATABASE_PATH: ".playwright/loopboard.sqlite",
      LOOPBOARD_TASK_CONTEXT_ROOT: ".playwright/task-contexts",
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
