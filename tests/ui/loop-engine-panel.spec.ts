import { expect, test } from "@playwright/test";

test("shows Loop Engine panel with global auto-run disabled by default", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByTestId("loop-engine-panel")).toBeVisible();
  await expect(page.getByText("global auto-run disabled")).toBeVisible();
  await expect(page.getByTestId("engine-start-scheduler")).toBeDisabled();
  await expect(
    page.getByText("Start Scheduler requires global auto-run"),
  ).toBeVisible();
  await expect(page.getByTestId("engine-active-jobs-header")).toBeVisible();
  await expect(page.getByTestId("project-metrics")).toContainText("Engine (24h)");
});

test("runs a demo job through manual tick and opens the job detail drawer", async ({
  page,
}) => {
  await page.goto("/");

  const demoResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/api/engine/demo-job") &&
      response.ok(),
  );
  await page.getByTestId("engine-run-demo-job").click();
  await demoResponse;

  const tickResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/api/engine/tick") &&
      response.ok(),
  );
  await page.getByTestId("engine-tick-once").click();
  await tickResponse;

  await expect(page.getByTestId("loop-engine-panel")).toContainText("completed");

  const completedRow = page.locator('[data-testid^="engine-job-row-"]').filter({
    hasText: "completed",
  });
  await expect(completedRow.first()).toBeVisible();
  await completedRow.first().click();

  await expect(page.getByTestId("engine-job-detail-drawer")).toBeVisible();
  await page.getByTestId("engine-job-detail-close").click();
  await expect(page.getByTestId("engine-job-detail-drawer")).not.toBeVisible();
});

test("keeps Loop Engine controls visible on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(page.getByTestId("loop-engine-panel")).toBeVisible();
  await expect(page.getByTestId("engine-run-demo-job")).toBeVisible();
  await expect(page.getByTestId("engine-tick-once")).toBeVisible();
  await expect(page.getByTestId("engine-start-scheduler")).toBeVisible();
});

test("shows engine empty states and metrics hint before first tick", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByTestId("engine-empty-state-engine-never-run")).toBeVisible();
  await expect(page.getByTestId("engine-(24h)-empty-hint")).toContainText(
    "No engine activity recorded in the last 24 hours",
  );
  await expect(page.getByTestId("backend-availability-chips")).toBeVisible();
});

test("keeps job recovery actions visible on mobile when drawer is open", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await page.getByTestId("engine-run-demo-job").click();
  await page.getByTestId("engine-tick-once").click();

  const completedRow = page.locator('[data-testid^="engine-job-row-"]').filter({
    hasText: "completed",
  });
  await completedRow.first().click();

  const recoveryActions = page.getByTestId("engine-job-recovery-actions");
  await expect(recoveryActions).toBeVisible();
  await expect(page.getByTestId("engine-job-retry")).toBeVisible();
  await expect(page.getByTestId("engine-job-cancel")).toBeVisible();
});
