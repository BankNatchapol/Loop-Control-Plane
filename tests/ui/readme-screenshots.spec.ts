import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const screenshotDir = path.join(process.cwd(), "docs", "screenshots");

test.describe("README screenshots", () => {
  test.skip(
    () => !process.env.CAPTURE_SCREENSHOTS,
    "Run with CAPTURE_SCREENSHOTS=1 via npm run screenshots:readme",
  );

  test.use({
    viewport: { width: 1440, height: 900 },
  });

  test.beforeAll(() => {
    mkdirSync(screenshotDir, { recursive: true });
  });

  test("captures README screenshots", async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto("/");

    await expect(
      page.getByRole("heading", { name: "Loop Control Plane" }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("project-metrics")).toBeVisible();
    await expect(page.getByTestId("workflow-editor")).toBeVisible();
    await expect(page.getByTestId("loop-engine-panel")).toBeVisible();

    await page.screenshot({
      path: path.join(screenshotDir, "hero.png"),
      animations: "disabled",
    });

    await page.getByTestId("dashboard-filter-all").click();
    const board = page.locator("[data-board-scroll]");
    await expect(board).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Implement draggable board state" }),
    ).toBeVisible();

    await board.screenshot({
      path: path.join(screenshotDir, "kanban-board.png"),
      animations: "disabled",
    });

    await page
      .getByRole("heading", { name: "Implement draggable board state" })
      .click();
    await expect(page.getByText("GitHub Delivery")).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve AO Ready" })).toBeVisible();

    const aside = page.locator("aside").first();
    await aside.screenshot({
      path: path.join(screenshotDir, "task-detail.png"),
      animations: "disabled",
    });

    const workflowEditor = page.getByTestId("workflow-editor");
    await workflowEditor.scrollIntoViewIfNeeded();
    await expect(
      workflowEditor.getByRole("heading", { name: "Feature Development Loop" }),
    ).toBeVisible();
    await expect(workflowEditor.getByText("11 nodes · 11 edges")).toBeVisible();

    await workflowEditor.screenshot({
      path: path.join(screenshotDir, "workflow-editor.png"),
      animations: "disabled",
    });

    const loopEnginePanel = page.getByTestId("loop-engine-panel");
    await loopEnginePanel.scrollIntoViewIfNeeded();
    await expect(loopEnginePanel.getByText("Loop Engine")).toBeVisible();
    await expect(page.getByTestId("backend-availability-chips")).toBeVisible();

    await loopEnginePanel.screenshot({
      path: path.join(screenshotDir, "loop-engine.png"),
      animations: "disabled",
    });
  });
});
