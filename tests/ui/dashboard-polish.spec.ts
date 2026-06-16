import { expect, test } from "@playwright/test";

test("shows project metrics and persists dashboard quick filters", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("project-metrics")).toContainText("Tasks By Status");
  await expect(page.getByTestId("project-metrics")).toContainText("Tasks By Owner");
  await expect(page.getByTestId("project-metrics")).toContainText("Tasks By Risk");
  await expect(page.getByTestId("dashboard-filter-human-working")).toContainText("1");

  await page.getByTestId("dashboard-filter-human-working").click();
  await expect(page.getByRole("heading", { name: "Wire human takeover actions" })).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("dashboard-filter-human-working")).toHaveClass(
    /border-sky-300/,
  );
  await expect(page.getByRole("heading", { name: "Wire human takeover actions" })).toBeVisible();

  await page.getByTestId("dashboard-filter-all").click();
  await expect(page.getByRole("heading", { name: "Implement draggable board state" })).toBeVisible();
});

test("keeps dashboard controls visible on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(page.getByTestId("project-metrics")).toBeVisible();
  await expect(page.getByTestId("dashboard-filter-ai-running")).toBeVisible();
  await expect(page.getByText("Effective Automation Policy")).toBeVisible();
  await expect(page.getByTestId("workflow-editor")).toBeVisible();
});
