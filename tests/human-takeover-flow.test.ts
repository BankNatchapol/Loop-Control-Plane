import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";

import { applyMigrations } from "@/db/migrate";
import { seedDatabase } from "@/db/seed";
import {
  applyPersistedTaskAction,
  fetchPersistedTaskHandoff,
  generatePersistedTaskClaudeCodePrompt,
  openTask,
  refreshPersistedTaskHandoff,
  savePersistedTaskHandoff,
} from "@/lib/api/loopboard-client";
import {
  appendTaskHandoffNote,
  generateTaskClaudeCodePrompt,
  refreshTaskHandoff,
  syncExistingTaskEventsFile,
} from "@/lib/api/task-context-actions";
import { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import { syncGitHubIssueLabels } from "@/lib/github/github-issues";
import { seedProject } from "@/lib/loopboard";
import { openTaskPath, type TaskCommandRunner } from "@/lib/tasks/task-open-actions";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const withRepositoryAndContext = async (
  test: (input: {
    repository: LoopBoardRepository;
    database: DatabaseSync;
    tempDirectory: string;
    contextRoot: string;
  }) => void | Promise<void>,
): Promise<void> => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "loopboard-takeover-flow-"));
  const database = new DatabaseSync(join(tempDirectory, "loopboard.sqlite"));
  const contextRoot = join(tempDirectory, "task-contexts");
  const originalContextRoot = process.env.LOOPBOARD_TASK_CONTEXT_ROOT;

  try {
    process.env.LOOPBOARD_TASK_CONTEXT_ROOT = contextRoot;
    applyMigrations(database);
    seedDatabase(database);

    await test({
      repository: new LoopBoardRepository(database),
      database,
      tempDirectory,
      contextRoot,
    });
  } finally {
    database.close();
    if (originalContextRoot === undefined) {
      delete process.env.LOOPBOARD_TASK_CONTEXT_ROOT;
    } else {
      process.env.LOOPBOARD_TASK_CONTEXT_ROOT = originalContextRoot;
    }
    rmSync(tempDirectory, { recursive: true, force: true });
  }
};

describe("human takeover and return flow", () => {
  it("persists takeover, refreshes handoff/events, generates prompts, and returns to AI", async () => {
    await withRepositoryAndContext(async ({ repository, contextRoot, tempDirectory }) => {
      const repoPath = join(tempDirectory, "repo");
      repository.updateProject(seedProject.id, { repoPath });
      mkdirSync(repoPath, { recursive: true });
      const worktreePath = join(repoPath, "worktrees", "local-persistence");
      mkdirSync(worktreePath, { recursive: true });
      repository.updateTask("task-local-persistence-reset", {
        worktree: worktreePath,
        github: {
          issueNumber: 36,
          issueUrl: "https://github.com/bank-p/loop-control-plane/issues/36",
          issueState: "open",
          issueLabels: ["loopboard", "risk-low", "ao-ready"],
          pullRequestNumber: 41,
          pullRequestUrl: "https://github.com/bank-p/loop-control-plane/pull/41",
          pullRequestState: "open",
        },
      });

      const assigned = repository.applyTaskAction(
        "task-local-persistence-reset",
        "assign-ai",
      );
      assert.equal(assigned.owner, "ai");
      assert.equal(assigned.status, "ai-running");
      assert.ok(assigned.github.issueLabels?.includes("ao-ready"));

      const claimed = repository.applyTaskAction(
        "task-local-persistence-reset",
        "claim-human",
      );
      refreshTaskHandoff(repository, claimed.id);
      syncExistingTaskEventsFile(repository.getTask(claimed.id));

      assert.equal(claimed.owner, "human");
      assert.equal(claimed.status, "human-working");
      assert.equal(claimed.mode, "handoff");
      assert.deepEqual(claimed.events.slice(-2).map((event) => event.type), [
        "HUMAN_TAKEOVER",
        "ASSIGNED_TO_HUMAN",
      ]);
      assert.equal(claimed.events.at(-2)?.metadata?.worktree, worktreePath);
      assert.equal(claimed.github.issueLabels?.includes("ao-ready"), false);
      assert.equal(claimed.github.issueLabels?.includes("human-working"), true);

      const handoffPath = join(contextRoot, claimed.id, "handoff.md");
      const eventsPath = join(contextRoot, claimed.id, "events.jsonl");
      assert.equal(existsSync(handoffPath), true);
      assert.equal(existsSync(eventsPath), true);
      assert.match(readFileSync(handoffPath, "utf8"), /Status: Human Working/);
      assert.equal(
        JSON.parse(readFileSync(eventsPath, "utf8").trim().split("\n").at(-1) ?? "{}")
          .type,
        "ASSIGNED_TO_HUMAN",
      );

      const promptResult = generateTaskClaudeCodePrompt(
        repository,
        claimed.id,
        "Continue from handoff. OPENAI_API_KEY=sk-secret1234567890",
      );
      assert.match(promptResult.prompt.prompt, /Manual Edit Intent/);
      assert.match(promptResult.prompt.prompt, /Linked GitHub Context/);
      assert.match(promptResult.prompt.prompt, /#41/);
      assert.doesNotMatch(promptResult.prompt.prompt, /sk-secret1234567890/);
      assert.match(promptResult.prompt.prompt, /OPENAI_API_KEY=\[redacted\]/);

      const launches: Array<{ command: string; args: string[] }> = [];
      const runner: TaskCommandRunner = {
        commandAvailable: () => true,
        launch: (command, args) => {
          launches.push({ command, args });
        },
      };
      const openResult = openTaskPath(
        repository.getProject(seedProject.id),
        repository.getTask(claimed.id),
        "open-worktree-vscode",
        runner,
      );
      assert.equal(openResult.path, worktreePath);
      assert.deepEqual(launches, [{ command: "code", args: [worktreePath] }]);

      const gitHubCalls: Array<{ url: string; body: unknown }> = [];
      const humanLabelSync = await syncGitHubIssueLabels({
        repository: "bank-p/loop-control-plane",
        token: "token",
        issueNumber: claimed.github.issueNumber ?? 0,
        labels: claimed.github.issueLabels ?? [],
        fetcher: async (input, init) => {
          gitHubCalls.push({
            url: String(input),
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
          });
          return Response.json(
            (claimed.github.issueLabels ?? []).map((name) => ({ name })),
          );
        },
      });
      assert.equal(humanLabelSync.status, "synced");
      assert.deepEqual(gitHubCalls[0]?.body, {
        labels: ["loopboard", "risk-low", "human-working"],
      });

      appendTaskHandoffNote(repository, claimed.id, "Manual edit complete.");
      const returned = repository.applyTaskAction(claimed.id, "return-ai");
      appendTaskHandoffNote(repository, returned.id, "Ready for AO.");
      syncExistingTaskEventsFile(returned);

      assert.equal(returned.owner, "ai");
      assert.equal(returned.status, "ready");
      assert.equal(returned.github.issueLabels?.includes("human-working"), false);
      assert.equal(returned.github.issueLabels?.includes("ao-ready"), true);
      assert.deepEqual(returned.events.slice(-2).map((event) => event.type), [
        "RETURNED_TO_AI",
        "ASSIGNED_TO_AI",
      ]);
      assert.match(readFileSync(handoffPath, "utf8"), /Ready for AO\./);

      await syncGitHubIssueLabels({
        repository: "bank-p/loop-control-plane",
        token: "token",
        issueNumber: returned.github.issueNumber ?? 0,
        labels: returned.github.issueLabels ?? [],
        fetcher: async (input, init) => {
          gitHubCalls.push({
            url: String(input),
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
          });
          return Response.json(
            (returned.github.issueLabels ?? []).map((name) => ({ name })),
          );
        },
      });
      assert.deepEqual(gitHubCalls[1]?.body, {
        labels: ["loopboard", "risk-low", "ao-ready"],
      });
    });
  });

  it("drives the browser takeover UI flow through mocked API calls", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    globalThis.fetch = async (input, init) => {
      const request: { url: string; method: string; body?: unknown } = {
        url: String(input),
        method: init?.method ?? "GET",
      };

      if (init?.body) {
        request.body = JSON.parse(String(init.body));
      }
      requests.push(request);

      return Response.json({
        ok: true,
        data: String(input).endsWith("/open")
          ? {
              action: "open-worktree-vscode",
              taskId: "task-local-persistence-reset",
              projectId: seedProject.id,
              path: "/tmp/worktrees/local-persistence",
              pathKind: "worktree",
              usedFallback: false,
              command: "code",
              message: "Opening task worktree in VS Code.",
            }
          : String(init?.body).includes("generate-claude-prompt")
            ? {
                task: { id: "task-local-persistence-reset" },
                context: { taskId: "task-local-persistence-reset", files: {} },
                prompt: {
                  taskId: "task-local-persistence-reset",
                  prompt: "You are Claude Code working in a local LoopBoard handoff.",
                  paths: {
                    directory: "/tmp/task-contexts/task-local-persistence-reset",
                    task: "/tmp/task-contexts/task-local-persistence-reset/task.md",
                    context: "/tmp/task-contexts/task-local-persistence-reset/context.md",
                    handoff: "/tmp/task-contexts/task-local-persistence-reset/handoff.md",
                    events: "/tmp/task-contexts/task-local-persistence-reset/events.jsonl",
                  },
                  sourceArtifacts: [],
                  generatedAt: "2026-06-15T04:00:00.000Z",
                },
              }
            : {
                task: { id: "task-local-persistence-reset" },
                context: { taskId: "task-local-persistence-reset", files: {} },
                handoff: {
                  taskId: "task-local-persistence-reset",
                  exists: true,
                  path: "/tmp/task-contexts/task-local-persistence-reset/handoff.md",
                  relativePath: "task-local-persistence-reset/handoff.md",
                  content: "# Handoff\n\n## Human notes\n\nManual note.",
                  sections: {
                    generated: {
                      sourceOfTruth: "LoopBoard task state",
                      refreshBehavior: "Refreshed from generated state.",
                    },
                    humanNotes: {
                      sourceOfTruth: "handoff.md manual edits",
                      refreshBehavior: "Preserved across automatic handoff refreshes.",
                    },
                  },
                },
              },
      });
    };

    await applyPersistedTaskAction({
      taskId: "task-local-persistence-reset",
      action: "claim-human",
    });
    await openTask({
      taskId: "task-local-persistence-reset",
      action: "open-worktree-vscode",
    });
    await generatePersistedTaskClaudeCodePrompt({
      taskId: "task-local-persistence-reset",
      manualIntent: "Keep the manual edit focused.",
    });
    await fetchPersistedTaskHandoff("task-local-persistence-reset");
    await savePersistedTaskHandoff({
      taskId: "task-local-persistence-reset",
      content: "# Handoff\n\n## Human notes\n\nManual note.",
    });
    await refreshPersistedTaskHandoff("task-local-persistence-reset");
    await applyPersistedTaskAction({
      taskId: "task-local-persistence-reset",
      action: "return-ai",
      handoffNote: "Manual edit is ready for the next AI pass.",
    });

    assert.deepEqual(requests, [
      {
        url: "/api/tasks/task-local-persistence-reset/actions",
        method: "POST",
        body: { action: "claim-human" },
      },
      {
        url: "/api/tasks/task-local-persistence-reset/open",
        method: "POST",
        body: { action: "open-worktree-vscode" },
      },
      {
        url: "/api/tasks/task-local-persistence-reset/context",
        method: "POST",
        body: {
          action: "generate-claude-prompt",
          manualIntent: "Keep the manual edit focused.",
        },
      },
      {
        url: "/api/tasks/task-local-persistence-reset/context",
        method: "POST",
        body: { action: "read-handoff" },
      },
      {
        url: "/api/tasks/task-local-persistence-reset/context",
        method: "POST",
        body: {
          action: "save-handoff",
          content: "# Handoff\n\n## Human notes\n\nManual note.",
        },
      },
      {
        url: "/api/tasks/task-local-persistence-reset/context",
        method: "POST",
        body: { action: "refresh-handoff" },
      },
      {
        url: "/api/tasks/task-local-persistence-reset/actions",
        method: "POST",
        body: {
          action: "return-ai",
          handoffNote: "Manual edit is ready for the next AI pass.",
        },
      },
    ]);
  });

  it("keeps task detail UI wired for prompt copy and dirty handoff refresh warnings", () => {
    const pageSource = readFileSync(join(process.cwd(), "app/page.tsx"), "utf8");

    assert.match(pageSource, /navigator\.clipboard\.writeText\(claudePrompt\.prompt\)/);
    assert.match(pageSource, /Claude Code prompt copied to clipboard\./);
    assert.match(pageSource, /Copy Claude Code Prompt/);
    assert.match(pageSource, /handoffIsDirty[\s\S]*window\.confirm/);
    assert.match(pageSource, /Unsaved handoff\.md edits/);
  });
});
