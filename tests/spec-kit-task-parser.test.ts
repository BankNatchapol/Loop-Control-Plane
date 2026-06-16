import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  inferAreaLabels,
  inferRiskLevel,
  parseSpecKitTasksMarkdown,
} from "@/lib/importers/spec-kit-task-parser";

const readParserFixture = (fileName: string): string =>
  readFileSync(
    join(process.cwd(), "tests", "fixtures", "spec-kit-parser", fileName),
    "utf8",
  );

describe("Spec Kit task parser", () => {
  it("parses simple checkbox tasks with IDs, completion state, and file references", () => {
    const result = parseSpecKitTasksMarkdown(readParserFixture("simple-tasks.md"));

    assert.equal(result.tasks.length, 2);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(
      result.tasks.map((task) => ({
        sourceId: task.sourceId,
        completed: task.completed,
        title: task.title,
        fileReferences: task.fileReferences,
        labels: task.labels,
      })),
      [
        {
          sourceId: "T001",
          completed: false,
          title: "Set up project README in `README.md`",
          fileReferences: ["README.md"],
          labels: ["docs"],
        },
        {
          sourceId: "T002",
          completed: true,
          title: "Update styles in `app/page.tsx`",
          fileReferences: ["app/page.tsx"],
          labels: ["frontend"],
        },
      ],
    );
  });

  it("parses nested acceptance criteria without dropping task notes", () => {
    const result = parseSpecKitTasksMarkdown(readParserFixture("nested-acceptance.md"));
    const task = result.tasks[0];

    assert.equal(result.tasks.length, 1);
    assert.equal(task?.sourceId, "T010");
    assert.deepEqual(task?.headings, ["Tasks", "Import Preview"]);
    assert.deepEqual(task?.acceptanceCriteria, [
      "User can review parsed tasks.",
      "User can exclude individual tasks.",
      "Import button stays disabled with no included tasks.",
    ]);
    assert.deepEqual(task?.notes, ["Note: Copy may change after UX review."]);
  });

  it("parses dependency aliases from task bodies", () => {
    const result = parseSpecKitTasksMarkdown(readParserFixture("dependencies.md"));

    assert.deepEqual(
      result.tasks.map((task) => [task.sourceId, task.dependencies]),
      [
        ["T020", ["T010", "T011"]],
        ["T021", ["T020"]],
        ["T022", ["T020", "T021"]],
      ],
    );
    assert.deepEqual(result.tasks[1]?.description, "Write imported tasks to the repository.");
  });

  it("parses headings, checkbox tasks, IDs, dependencies, acceptance criteria, and notes", () => {
    const result = parseSpecKitTasksMarkdown(readParserFixture("mixed-tasks.md"));

    assert.equal(result.tasks.length, 4);
    assert.deepEqual(result.warnings, []);

    const first = result.tasks[0];
    assert.equal(first.sourceId, "T001");
    assert.equal(first.sourceLine, 5);
    assert.equal(first.completed, false);
    assert.deepEqual(first.headings, ["Tasks", "Phase 1: Backend"]);
    assert.equal(first.title, "Create importer API route in `app/api/spec-kit/import/route.ts`");
    assert.equal(first.description, "Parse feature folder input and return preview data.");
    assert.deepEqual(first.fileReferences, ["app/api/spec-kit/import/route.ts"]);
    assert.deepEqual(first.dependencies, ["T000"]);
    assert.deepEqual(first.acceptanceCriteria, [
      "Returns parsed tasks without writing database rows.",
      "Reports missing artifacts as warnings.",
    ]);
    assert.deepEqual(first.labels, ["backend"]);
    assert.equal(first.risk, "high");
    assert.deepEqual(first.notes, ["Note: API auth policy remains open."]);

    const second = result.tasks[1];
    assert.equal(second.completed, true);
    assert.equal(second.title, "Add parser tests in tests/spec-kit-task-parser.test.ts");
    assert.deepEqual(second.labels, ["test"]);

    const third = result.tasks[2];
    assert.equal(third.title, "Build preview component in `app/page.tsx`");
    assert.deepEqual(third.acceptanceCriteria, ["User can exclude an imported task."]);
    assert.deepEqual(third.notes, ["Unknown: final modal copy."]);
    assert.deepEqual(third.labels, ["frontend"]);

    const fourth = result.tasks[3];
    assert.equal(fourth.sourceId, "line-22");
    assert.equal(fourth.title, "Harden auth permissions before deleting stale imported tasks");
    assert.deepEqual(fourth.dependencies, ["T001", "T003"]);
    assert.equal(fourth.risk, "high");
  });

  it("links sibling Spec Kit artifacts when tasks.md has a filesystem path", () => {
    const repoPath = mkdtempSync(join(tmpdir(), "loopboard-spec-kit-parser-"));
    const featureFolder = join(repoPath, "specs", "feature-a");
    const tasksPath = join(featureFolder, "tasks.md");

    try {
      mkdirSync(featureFolder, { recursive: true });
      writeFileSync(join(featureFolder, "PRD.md"), "# PRD\n", "utf8");
      writeFileSync(join(featureFolder, "spec.md"), "# Spec\n", "utf8");
      writeFileSync(join(featureFolder, "plan.md"), "# Plan\n", "utf8");
      writeFileSync(tasksPath, "- [ ] T001 Do the work\n", "utf8");

      const result = parseSpecKitTasksMarkdown(readFileSync(tasksPath, "utf8"), {
        tasksPath,
      });

      assert.deepEqual(
        result.artifacts.map((artifact) => [artifact.name, artifact.path, artifact.exists]),
        [
          ["prd", "PRD.md", true],
          ["spec", "spec.md", true],
          ["plan", "plan.md", true],
          ["tasks", "tasks.md", true],
          ["decisions", "decisions.md", false],
        ],
      );
      assert.deepEqual(result.tasks[0].sourceArtifactPaths, [
        "PRD.md",
        "spec.md",
        "plan.md",
        "tasks.md",
      ]);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("infers area labels and conservative risk levels from task text and paths", () => {
    const riskFixture = parseSpecKitTasksMarkdown(readParserFixture("higher-risk.md"));

    assert.deepEqual(
      inferAreaLabels("Update React UI in app/page.tsx and document README.md with tests/foo.test.ts"),
      ["frontend", "test", "docs"],
    );
    assert.equal(inferRiskLevel("Add CSS-only polish"), "low");
    assert.equal(inferRiskLevel("Change API schema for repository integration"), "medium");
    assert.equal(inferRiskLevel("Refactor authentication permissions"), "high");
    assert.equal(inferRiskLevel("Rotate billing credentials and payment secrets"), "critical");
    assert.deepEqual(
      riskFixture.tasks.map((task) => [task.sourceId, task.risk]),
      [
        ["T030", "critical"],
        ["T031", "high"],
        ["T032", "high"],
      ],
    );
  });
});
