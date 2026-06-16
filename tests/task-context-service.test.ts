import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  TaskContextService,
  relativeContextPaths,
} from "@/lib/context/task-context-service";
import type { BoardData } from "@/lib/db/loopboard-repository";
import { seedFeatures, seedProject, seedTasks, type TaskEvent } from "@/lib/loopboard";
import { defaultAutomationSettings } from "@/lib/policies/automation-policy";

const withTempRoot = (test: (root: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), "loopboard-contexts-"));

  try {
    test(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe("TaskContextService", () => {
  it("generates task, context, handoff, and events files for a task", () => {
    withTempRoot((root) => {
      const service = new TaskContextService(root);
      const task = {
        ...seedTasks[1],
        dependencies: ["task-import-spec-kit-board"],
      };
      const generated = service.generateTaskContext({
        task,
        project: seedProject,
        feature: seedFeatures[0],
      });

      assert.equal(generated.taskId, task.id);
      assert.ok(existsSync(generated.paths.task));
      assert.ok(existsSync(generated.paths.context));
      assert.ok(existsSync(generated.paths.handoff));
      assert.ok(existsSync(generated.paths.events));

      const taskMarkdown = readFileSync(generated.paths.task, "utf8");
      assert.match(taskMarkdown, /# Implement draggable board state/);
      assert.match(taskMarkdown, /Status: AI Running \(ai-running\)/);
      assert.match(taskMarkdown, /Dependencies: task-import-spec-kit-board/);
      assert.match(taskMarkdown, /Pull Request: #24/);
      assert.match(taskMarkdown, /Acceptance Criteria/);

      const contextMarkdown = readFileSync(generated.paths.context, "utf8");
      assert.match(contextMarkdown, /Source Artifacts/);
      assert.match(
        contextMarkdown,
        /specs\/loopboard-mvp\/kanban-control-plane\/spec.md/,
      );
      assert.match(contextMarkdown, /components\/board\/task-board.tsx/);

      const handoffMarkdown = readFileSync(generated.paths.handoff, "utf8");
      assert.match(handoffMarkdown, /Latest Event Timeline/);
      assert.match(handoffMarkdown, /AI_ASSIGNED/);
      assert.match(handoffMarkdown, /TASK_MOVED/);

      const events = readFileSync(generated.paths.events, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string });
      assert.deepEqual(
        events.map((event) => event.type),
        ["AI_ASSIGNED", "TASK_MOVED"],
      );
    });
  });

  it("preserves human notes while refreshing generated sections", () => {
    withTempRoot((root) => {
      const service = new TaskContextService(root);
      const task = {
        ...seedTasks[0],
        dependencies: [],
      };
      const generated = service.generateTaskContext({
        task,
        project: seedProject,
        feature: seedFeatures[0],
      });

      writeFileSync(
        generated.paths.handoff,
        [
          "<!-- LOOPBOARD:GENERATED:START -->",
          "# stale generated content",
          "<!-- LOOPBOARD:GENERATED:END -->",
          "",
          "<!-- LOOPBOARD:HUMAN_NOTES:START -->",
          "Keep this reviewer note.",
          "<!-- LOOPBOARD:HUMAN_NOTES:END -->",
          "",
        ].join("\n"),
        "utf8",
      );

      const refreshed = service.generateTaskContext({
        task: {
          ...task,
          status: "needs-review",
          updatedAt: "2026-06-14T06:00:00.000Z",
        },
        project: seedProject,
        feature: seedFeatures[0],
      });
      const handoffMarkdown = readFileSync(refreshed.paths.handoff, "utf8");

      assert.doesNotMatch(handoffMarkdown, /stale generated content/);
      assert.match(handoffMarkdown, /Status: Needs Review \(needs-review\)/);
      assert.match(handoffMarkdown, /Keep this reviewer note\./);
    });
  });

  it("generates contexts for every task in board data", () => {
    withTempRoot((root) => {
      const service = new TaskContextService(root);
      const board: BoardData = {
        projects: [seedProject],
        features: seedFeatures,
        tasks: seedTasks.map((task) => ({ ...task, dependencies: [] })),
        latestWorkflowRuns: [],
        automationSettings: defaultAutomationSettings,
      };
      const generated = service.generateBoardContexts(board);

      assert.equal(generated.length, seedTasks.length);
      assert.ok(
        generated.every((context) => existsSync(context.paths.events)),
      );
      assert.deepEqual(relativeContextPaths(generated[0], root), {
        directory: seedTasks[0].id,
        task: join(seedTasks[0].id, "task.md"),
        context: join(seedTasks[0].id, "context.md"),
        handoff: join(seedTasks[0].id, "handoff.md"),
        events: join(seedTasks[0].id, "events.jsonl"),
      });
    });
  });

  it("exports task events without requiring full context generation", () => {
    withTempRoot((root) => {
      const service = new TaskContextService(root);
      const task = {
        ...seedTasks[0],
        dependencies: [],
      };
      const generated = service.exportEvents(task);

      assert.ok(existsSync(generated.paths.directory));
      assert.ok(existsSync(generated.paths.events));
      assert.equal(existsSync(generated.paths.handoff), false);

      const events = readFileSync(generated.paths.events, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string });
      assert.deepEqual(
        events.map((event) => event.type),
        ["TASK_IMPORTED"],
      );
    });
  });

  it("groups GitHub sync events in handoff timeline with external links", () => {
    withTempRoot((root) => {
      const service = new TaskContextService(root);
      const events: TaskEvent[] = [
        {
          id: "event-pr-opened",
          taskId: seedTasks[1].id,
          type: "PR_OPENED",
          actor: "system",
          message: "Discovered GitHub pull request #147.",
          createdAt: "2026-06-15T01:10:00.000Z",
          metadata: {
            pullRequestNumber: 147,
            pullRequestUrl:
              "https://github.com/bank-p/loop-control-plane/pull/147",
          },
        },
        {
          id: "event-ci-failed",
          taskId: seedTasks[1].id,
          type: "CI_FAILED",
          actor: "system",
          message: "CI failed for pull request #147.",
          createdAt: "2026-06-15T01:10:00.000Z",
          metadata: {
            pullRequestNumber: 147,
            pullRequestUrl:
              "https://github.com/bank-p/loop-control-plane/pull/147",
            ciFailureSummary:
              "unit tests (https://github.com/bank-p/loop-control-plane/actions/runs/3/job/4)",
          },
        },
        {
          id: "event-review-changes",
          taskId: seedTasks[1].id,
          type: "REVIEW_CHANGES_REQUESTED",
          actor: "system",
          message: "Changes requested on pull request #147.",
          createdAt: "2026-06-15T01:10:00.000Z",
          metadata: {
            pullRequestNumber: 147,
            pullRequestUrl:
              "https://github.com/bank-p/loop-control-plane/pull/147",
            reviewUrl:
              "https://github.com/bank-p/loop-control-plane/pull/147#pullrequestreview-1",
          },
        },
      ];
      const task = {
        ...seedTasks[1],
        dependencies: [],
        events,
      };

      const generated = service.generateTaskContext({
        task,
        project: seedProject,
        feature: seedFeatures[0],
      });
      const handoffMarkdown = readFileSync(generated.paths.handoff, "utf8");
      const eventsJsonl = readFileSync(generated.paths.events, "utf8");

      assert.match(handoffMarkdown, /\[GITHUB_SYNC\] 3 updates/u);
      assert.match(
        handoffMarkdown,
        /PR: https:\/\/github\.com\/bank-p\/loop-control-plane\/pull\/147/u,
      );
      assert.match(
        handoffMarkdown,
        /failed check: https:\/\/github\.com\/bank-p\/loop-control-plane\/actions\/runs\/3\/job\/4/u,
      );
      assert.match(
        handoffMarkdown,
        /review: https:\/\/github\.com\/bank-p\/loop-control-plane\/pull\/147#pullrequestreview-1/u,
      );
      assert.match(handoffMarkdown, /External GitHub signal/u);
      assert.match(eventsJsonl, /"type":"CI_FAILED"/u);
      assert.match(eventsJsonl, /"reviewUrl"/u);
    });
  });

  it("refreshes handoff markdown with current PR, CI, and review state", () => {
    withTempRoot((root) => {
      const service = new TaskContextService(root);
      const task = {
        ...seedTasks[1],
        dependencies: [],
        status: "needs-review" as const,
        github: {
          ...seedTasks[1].github,
          pullRequestNumber: 188,
          pullRequestUrl: "https://github.com/bank-p/loop-control-plane/pull/188",
          pullRequestBranch: "feature/pr-ci-review",
          pullRequestState: "open" as const,
          mergeStatus: "mergeable" as const,
          ciStatus: "failing" as const,
          reviewStatus: "changes-requested" as const,
          deliveryStatus: "changes-requested" as const,
          prCiLastSyncedAt: "2026-06-15T02:30:00.000Z",
          ciFailureSummary:
            "unit tests (https://github.com/bank-p/loop-control-plane/actions/runs/188/job/1)",
        },
      };

      const refreshed = service.refreshHandoff({
        task,
        project: seedProject,
        feature: seedFeatures[1],
      });
      const handoffMarkdown = readFileSync(refreshed.paths.handoff, "utf8");

      assert.match(handoffMarkdown, /Pull Request: #188/u);
      assert.match(handoffMarkdown, /PR Branch: feature\/pr-ci-review/u);
      assert.match(handoffMarkdown, /PR State: open/u);
      assert.match(handoffMarkdown, /Merge Status: mergeable/u);
      assert.match(handoffMarkdown, /CI Status: failing/u);
      assert.match(handoffMarkdown, /Review Status: changes-requested/u);
      assert.match(handoffMarkdown, /Delivery Status: changes-requested/u);
      assert.match(
        handoffMarkdown,
        /External CI Failure Summary: \[external\/untrusted\]/u,
      );
      assert.match(handoffMarkdown, /PR\/CI Last Synced: 2026-06-15T02:30:00\.000Z/u);
      assert.match(
        handoffMarkdown,
        /unit tests \(https:\/\/github\.com\/bank-p\/loop-control-plane\/actions\/runs\/188\/job\/1\)/u,
      );
    });
  });

  it("refreshes only handoff markdown and preserves existing human notes", () => {
    withTempRoot((root) => {
      const service = new TaskContextService(root);
      const task = {
        ...seedTasks[0],
        dependencies: [],
      };
      const exported = service.exportEvents(task);

      writeFileSync(
        exported.paths.handoff,
        [
          "<!-- LOOPBOARD:GENERATED:START -->",
          "# stale handoff",
          "<!-- LOOPBOARD:GENERATED:END -->",
          "",
          "<!-- LOOPBOARD:HUMAN_NOTES:START -->",
          "Keep the reviewer checkpoint.",
          "<!-- LOOPBOARD:HUMAN_NOTES:END -->",
          "",
        ].join("\n"),
        "utf8",
      );

      const refreshed = service.refreshHandoff({
        task,
        project: seedProject,
        feature: seedFeatures[0],
      });

      assert.equal(refreshed.paths.handoff, exported.paths.handoff);
      assert.equal(existsSync(refreshed.paths.task), false);

      const handoffMarkdown = readFileSync(refreshed.paths.handoff, "utf8");
      assert.doesNotMatch(handoffMarkdown, /stale handoff/);
      assert.match(handoffMarkdown, /Handoff for Import Spec Kit tasks/);
      assert.match(handoffMarkdown, /Keep the reviewer checkpoint\./);
    });
  });

  it("preserves a visible Human notes section from manually edited handoff markdown", () => {
    withTempRoot((root) => {
      const service = new TaskContextService(root);
      const task = {
        ...seedTasks[0],
        dependencies: [],
      };
      const generated = service.refreshHandoff({
        task,
        project: seedProject,
        feature: seedFeatures[0],
      });

      service.saveHandoffDocument(
        task,
        [
          "# Manually edited handoff",
          "",
          "Generated text that should be replaced.",
          "",
          "## Human notes",
          "",
          "Keep this direct edit.",
          "",
          "## Scratch",
          "",
          "Discard this section on refresh.",
          "",
        ].join("\n"),
      );

      service.refreshHandoff({
        task: {
          ...task,
          status: "needs-review",
        },
        project: seedProject,
        feature: seedFeatures[0],
      });

      const handoffMarkdown = readFileSync(generated.paths.handoff, "utf8");
      assert.match(handoffMarkdown, /Status: Needs Review \(needs-review\)/);
      assert.doesNotMatch(handoffMarkdown, /Generated text that should be replaced/);
      assert.match(handoffMarkdown, /## Human notes/);
      assert.match(handoffMarkdown, /Keep this direct edit\./);
      assert.doesNotMatch(handoffMarkdown, /Discard this section on refresh/);
    });
  });

  it("reads and saves handoff markdown for manual UI editing", () => {
    withTempRoot((root) => {
      const service = new TaskContextService(root);
      const task = {
        ...seedTasks[0],
        dependencies: [],
      };

      const missing = service.readHandoffDocument(task);
      assert.equal(missing.exists, false);
      assert.equal(missing.content, "");
      assert.equal(missing.sections.generated.sourceOfTruth, "LoopBoard task state");

      const saved = service.saveHandoffDocument(
        task,
        "# Manual handoff\n\n## Human notes\n\nShip after review. OPENAI_API_KEY=sk-secret1234567890\n",
      );
      assert.equal(saved.exists, true);
      assert.match(saved.content, /Ship after review\./);
      assert.match(saved.content, /OPENAI_API_KEY=\[redacted\]/u);
      assert.doesNotMatch(saved.content, /sk-secret1234567890/u);
      assert.ok(saved.updatedAt);
      assert.equal(saved.sections.humanNotes.sourceOfTruth, "handoff.md manual edits");
    });
  });

  it("appends return notes to handoff human notes without replacing generated state", () => {
    withTempRoot((root) => {
      const service = new TaskContextService(root);
      const task = {
        ...seedTasks[0],
        dependencies: [],
      };
      const refreshed = service.refreshHandoff({
        task,
        project: seedProject,
        feature: seedFeatures[0],
      });

      service.appendHumanHandoffNote(task, "Tests passed locally.", {
        createdAt: "2026-06-15T05:00:00.000Z",
      });
      service.appendHumanHandoffNote(task, "", {
        createdAt: "2026-06-15T05:05:00.000Z",
      });

      const handoffMarkdown = readFileSync(refreshed.paths.handoff, "utf8");
      assert.match(handoffMarkdown, /Handoff for Import Spec Kit tasks/);
      assert.match(handoffMarkdown, /Status: Spec Review \(spec-review\)/);
      assert.match(handoffMarkdown, /### Return to AI - 2026-06-15T05:00:00\.000Z/);
      assert.match(handoffMarkdown, /Tests passed locally\./);
      assert.match(handoffMarkdown, /### Return to AI - 2026-06-15T05:05:00\.000Z/);
      assert.match(
        handoffMarkdown,
        /Human returned this task to AI\. Review the latest task state/u,
      );
    });
  });

  it("redacts secrets from generated handoff and exported external event metadata", () => {
    withTempRoot((root) => {
      const service = new TaskContextService(root);
      const task = {
        ...seedTasks[1],
        dependencies: [],
        github: {
          ...seedTasks[1].github,
          ciStatus: "failing" as const,
          ciFailureSummary:
            "unit tests failed with GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456",
        },
        events: [
          {
            id: "event-ci-secret",
            taskId: seedTasks[1].id,
            type: "CI_FAILED" as const,
            actor: "system" as const,
            message:
              "CI failed with OPENAI_API_KEY=sk-secret1234567890 in output.",
            createdAt: "2026-06-15T01:10:00.000Z",
            metadata: {
              ciFailureSummary:
                "logs include GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456",
            },
          },
        ],
      };

      const generated = service.generateTaskContext({
        task,
        project: seedProject,
        feature: seedFeatures[0],
      });
      const handoffMarkdown = readFileSync(generated.paths.handoff, "utf8");
      const eventsJsonl = readFileSync(generated.paths.events, "utf8");

      assert.match(handoffMarkdown, /External CI Failure Summary/u);
      assert.match(handoffMarkdown, /GITHUB_TOKEN=\[redacted\]/u);
      assert.doesNotMatch(handoffMarkdown, /ghp_abcdefghijklmnopqrstuvwxyz123456/u);
      assert.match(eventsJsonl, /OPENAI_API_KEY=\[redacted\]/u);
      assert.match(eventsJsonl, /GITHUB_TOKEN=\[redacted\]/u);
      assert.doesNotMatch(eventsJsonl, /sk-secret1234567890/u);
    });
  });

  it("syncs events only when a task context folder already exists", () => {
    withTempRoot((root) => {
      const service = new TaskContextService(root);
      const task = {
        ...seedTasks[0],
        dependencies: [],
      };

      assert.equal(service.syncExistingEventsFile(task), false);

      const generated = service.refreshHandoff({
        task,
        project: seedProject,
        feature: seedFeatures[0],
      });

      assert.equal(service.syncExistingEventsFile(task), true);
      assert.ok(existsSync(generated.paths.events));
    });
  });

  it("reports generated file status for task detail panels", () => {
    withTempRoot((root) => {
      const service = new TaskContextService(root);
      const task = {
        ...seedTasks[0],
        dependencies: [],
      };
      service.exportEvents(task);

      const status = service.getTaskContextStatus(task);

      assert.equal(status.taskId, task.id);
      assert.equal(status.files.directory.exists, true);
      assert.equal(status.files.events.exists, true);
      assert.equal(status.files.handoff.exists, false);
      assert.equal(status.files.events.relativePath, join(task.id, "events.jsonl"));
    });
  });

  it("generates a redacted Claude Code prompt from task context files", () => {
    withTempRoot((root) => {
      const service = new TaskContextService(root);
      const task = {
        ...seedTasks[2],
        dependencies: [],
        handoff: {
          ...seedTasks[2].handoff,
          summary: "AI stopped at the detail panel handoff.",
        },
        github: {
          ...seedTasks[2].github,
          ciStatus: "failing" as const,
          ciFailureSummary: "unit tests failed",
        },
      };
      const result = service.generateClaudeCodePrompt(
        {
          task,
          project: seedProject,
          feature: seedFeatures[1],
        },
        {
          manualIntent:
            "Focus on prompt UX. GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456",
          now: new Date("2026-06-15T04:00:00.000Z"),
        },
      );

      assert.equal(result.taskId, task.id);
      assert.ok(existsSync(result.paths.task));
      assert.ok(existsSync(result.paths.context));
      assert.ok(existsSync(result.paths.handoff));
      assert.match(result.prompt, /Manual Edit Intent/);
      assert.match(result.prompt, /Focus on prompt UX/u);
      assert.match(result.prompt, /Generated LoopBoard Files/);
      assert.match(result.prompt, /Trusted Handoff/);
      assert.match(result.prompt, /Current Diff Guidance/);
      assert.match(result.prompt, /Linked GitHub Context/);
      assert.match(result.prompt, /external\/untrusted/u);
      assert.match(result.prompt, /specs\/loopboard-mvp\/github-bridge\/PRD\.md/u);
      assert.match(result.prompt, /GITHUB_TOKEN=\[redacted\]/u);
      assert.doesNotMatch(result.prompt, /ghp_abcdefghijklmnopqrstuvwxyz123456/u);
      assert.equal(result.generatedAt, "2026-06-15T04:00:00.000Z");
    });
  });
});
