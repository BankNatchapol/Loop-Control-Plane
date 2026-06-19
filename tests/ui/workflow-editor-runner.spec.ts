import { expect, test, type Page } from "@playwright/test";

const runAction = async (
  page: Page,
  testId: string,
  action: "run-next" | "approve" | "skip",
) => {
  const response = page.waitForResponse((candidate) => {
    const request = candidate.request();
    const requestedAction =
      request.postData()?.includes(`"action":"${action}"`) === true ||
      request.headers()["x-loopboard-workflow-action"] === action ||
      new URL(candidate.url()).searchParams.get("action") === action;

    return (
      request.method() === "POST" &&
      candidate.url().includes("/api/workflow-runs/") &&
      candidate.url().includes("/actions") &&
      requestedAction &&
      candidate.ok()
    );
  });

  await page.getByTestId(testId).click();
  await response;
};

test("creates, connects, saves, runs, approves, and completes a workflow", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("banner")
    .getByRole("button", { name: "workflows", exact: true })
    .click();

  const editor = page.getByTestId("workflow-editor");
  await expect(editor).toBeVisible();
  await expect(
    editor.getByRole("heading", { name: "Feature Development Loop" }),
  ).toBeVisible();
  await expect(editor.getByText("12 nodes · 14 edges")).toBeVisible();

  await page.getByTestId("workflow-new").click();
  await expect(editor.getByText("2 nodes · 1 edges")).toBeVisible();
  await page.getByLabel("Workflow name").fill("Playwright Workflow");

  const saveResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/api/projects/") &&
      response.url().includes("/workflows") &&
      response.ok(),
  );
  await page.getByTestId("workflow-save").click();
  await saveResponse;
  await expect(page.getByLabel("Workflow definition")).toHaveValue(
    /workflow-/,
  );
  await expect(editor.getByRole("heading", { name: "Playwright Workflow" })).toBeVisible();

  const startResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/api/workflows/") &&
      response.url().includes("/runs") &&
      response.ok(),
  );
  await page.getByTestId("workflow-start-run").click();
  await startResponse;
  await expect(page.getByTestId("workflow-current-run")).toContainText(
    "Human Input",
  );

  await runAction(page, "workflow-run-next", "run-next");
  await expect(page.getByTestId("workflow-last-step")).toContainText(
    "waiting-approval",
  );

  await runAction(page, "workflow-approve", "approve");
  await expect(page.getByTestId("workflow-current-run")).toContainText(
    "Spec Kit Actions",
  );

  await runAction(page, "workflow-skip", "skip");
  await expect(page.getByTestId("workflow-message")).toContainText(
    "Workflow run completed.",
  );
  await expect(page.getByTestId("workflow-current-run")).toContainText("Complete");
});
