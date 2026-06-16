import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  LoopBoardApiError,
  applyWorkflowRunAction,
  approveFeatureArtifact,
  applyPersistedTaskAction,
  createFeature,
  createProject,
  createProjectWorkflow,
  deleteFeature,
  deleteProject,
  exportWorkflow,
  exportPersistedTaskEvents,
  fetchFeatureArtifactDocument,
  fetchPersistedTaskHandoff,
  fetchFeatures,
  fetchProjects,
  fetchTaskContextStatus,
  fetchBoardData,
  generatePersistedTaskClaudeCodePrompt,
  importSpecKitTasks,
  importProjectWorkflow,
  movePersistedTask,
  openProject,
  openTask,
  previewSpecKitTasks,
  refreshPersistedTaskHandoff,
  savePersistedTaskHandoff,
  saveFeatureArtifactDocument,
  startWorkflowRun,
  syncPersistedTaskGitHubPullRequest,
  updateFeature,
  updateProject,
  updateWorkflow,
  fetchProjectWorkflows,
} from "@/lib/api/loopboard-client";
import { seedFeatures, seedProject, seedTasks, seedWorkflows } from "@/lib/loopboard";
import { defaultAutomationSettings } from "@/lib/policies/automation-policy";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("LoopBoard browser API client", () => {
  it("loads board data through the persisted board endpoint", async () => {
    let requestedUrl = "";
    globalThis.fetch = async (input) => {
      requestedUrl = String(input);

      return Response.json({
        ok: true,
        data: {
          projects: [seedProject],
          features: seedFeatures,
          tasks: seedTasks,
          latestWorkflowRuns: [],
          automationSettings: defaultAutomationSettings,
        },
      });
    };

    const board = await fetchBoardData(seedProject.id);

    assert.equal(
      requestedUrl,
      `/api/board?projectId=${encodeURIComponent(seedProject.id)}`,
    );
    assert.equal(board.projects[0]?.id, seedProject.id);
    assert.equal(board.tasks.length, seedTasks.length);
    assert.deepEqual(board.latestWorkflowRuns, []);
  });

  it("posts task moves and actions to stable mutation endpoints", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
      });

      return Response.json({
        ok: true,
        data: seedTasks[0],
      });
    };

    await movePersistedTask({
      taskId: "task-local-persistence-reset",
      toStatus: "ai-running",
    });
    await applyPersistedTaskAction({
      taskId: "task-local-persistence-reset",
      action: "assign-ai",
    });
    await applyPersistedTaskAction({
      taskId: "task-local-persistence-reset",
      action: "return-ai",
      handoffNote: "Ready for the next AI pass.",
    });

    assert.deepEqual(requests, [
      {
        url: "/api/tasks/task-local-persistence-reset/move",
        body: { toStatus: "ai-running", actor: "human" },
      },
      {
        url: "/api/tasks/task-local-persistence-reset/actions",
        body: { action: "assign-ai" },
      },
      {
        url: "/api/tasks/task-local-persistence-reset/actions",
        body: {
          action: "return-ai",
          handoffNote: "Ready for the next AI pass.",
        },
      },
    ]);
  });

  it("posts manual PR and CI sync requests to the task GitHub PR endpoint", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
      });

      return Response.json({
        ok: true,
        data: {
          task: {
            ...seedTasks[0],
            github: {
              ...seedTasks[0].github,
              pullRequestNumber: 42,
              pullRequestUrl: "https://github.com/bank-p/loop-control-plane/pull/42",
              ciStatus: "passing",
              reviewStatus: "approved",
              prCiLastSyncedAt: "2026-06-15T00:00:00.000Z",
            },
          },
          sync: {
            status: "synced",
            repository: "bank-p/loop-control-plane",
            message: "Synced PR #42.",
            syncedAt: "2026-06-15T00:00:00.000Z",
            linkedIssueNumbers: [12],
          },
        },
      });
    };

    const result = await syncPersistedTaskGitHubPullRequest({
      taskId: seedTasks[0].id,
      pullRequestUrl: "https://github.com/bank-p/loop-control-plane/pull/42",
    });

    assert.equal(result.sync.status, "synced");
    assert.equal(result.task.github.pullRequestNumber, 42);
    assert.deepEqual(requests, [
      {
        url: `/api/tasks/${encodeURIComponent(seedTasks[0].id)}/github/pr`,
        body: {
          pullRequestUrl: "https://github.com/bank-p/loop-control-plane/pull/42",
        },
      },
    ]);
  });

  it("loads and mutates task context files through the task context endpoint", async () => {
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
        data: {
          task: seedTasks[0],
          context: {
            taskId: seedTasks[0].id,
            rootDirectory: "/tmp/task-contexts",
            files: {
              directory: {
                exists: true,
                path: "/tmp/task-contexts/task-import-spec-kit-board",
                relativePath: "task-import-spec-kit-board",
              },
              task: {
                exists: true,
                path: "/tmp/task-contexts/task-import-spec-kit-board/task.md",
                relativePath: "task-import-spec-kit-board/task.md",
              },
              context: {
                exists: true,
                path: "/tmp/task-contexts/task-import-spec-kit-board/context.md",
                relativePath: "task-import-spec-kit-board/context.md",
              },
              handoff: {
                exists: true,
                path: "/tmp/task-contexts/task-import-spec-kit-board/handoff.md",
                relativePath: "task-import-spec-kit-board/handoff.md",
              },
              events: {
                exists: true,
                path: "/tmp/task-contexts/task-import-spec-kit-board/events.jsonl",
                relativePath: "task-import-spec-kit-board/events.jsonl",
              },
            },
          },
        },
      });
    };

    await fetchTaskContextStatus("task-import-spec-kit-board");
    await exportPersistedTaskEvents("task-import-spec-kit-board");
    await refreshPersistedTaskHandoff("task-import-spec-kit-board");
    await fetchPersistedTaskHandoff("task-import-spec-kit-board");
    await savePersistedTaskHandoff({
      taskId: "task-import-spec-kit-board",
      content: "# Handoff\n\n## Human notes\n\nManual note.",
    });
    await generatePersistedTaskClaudeCodePrompt({
      taskId: "task-import-spec-kit-board",
      manualIntent: "Keep the edit small.",
    });

    assert.deepEqual(requests, [
      {
        url: "/api/tasks/task-import-spec-kit-board/context",
        method: "GET",
      },
      {
        url: "/api/tasks/task-import-spec-kit-board/context",
        method: "POST",
        body: { action: "export-events" },
      },
      {
        url: "/api/tasks/task-import-spec-kit-board/context",
        method: "POST",
        body: { action: "refresh-handoff" },
      },
      {
        url: "/api/tasks/task-import-spec-kit-board/context",
        method: "POST",
        body: { action: "read-handoff" },
      },
      {
        url: "/api/tasks/task-import-spec-kit-board/context",
        method: "POST",
        body: {
          action: "save-handoff",
          content: "# Handoff\n\n## Human notes\n\nManual note.",
        },
      },
      {
        url: "/api/tasks/task-import-spec-kit-board/context",
        method: "POST",
        body: {
          action: "generate-claude-prompt",
          manualIntent: "Keep the edit small.",
        },
      },
    ]);
  });

  it("posts project open actions to the project open endpoint", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
      });

      return Response.json({
        ok: true,
        data: {
          action: "open-vscode",
          projectId: seedProject.id,
          repoPath: seedProject.repoPath,
          command: "code",
          message: "Opening LoopBoard in VS Code.",
        },
      });
    };

    const result = await openProject({
      projectId: seedProject.id,
      action: "open-vscode",
    });

    assert.equal(result.command, "code");
    assert.deepEqual(requests, [
      {
        url: `/api/projects/${encodeURIComponent(seedProject.id)}/open`,
        body: { action: "open-vscode" },
      },
    ]);
  });

  it("loads, creates, and updates project workflow definitions", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const createWorkflowPayload = {
      name: seedWorkflows[0].name,
      description: seedWorkflows[0].description,
      nodes: seedWorkflows[0].nodes,
      edges: seedWorkflows[0].edges,
      config: seedWorkflows[0].config,
    };
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
        data:
          request.method === "GET"
            ? seedWorkflows
            : {
                ...seedWorkflows[0],
                name:
                  request.method === "PATCH"
                    ? "Updated Workflow"
                    : seedWorkflows[0].name,
              },
      });
    };

    await fetchProjectWorkflows(seedProject.id);
    await createProjectWorkflow({
      projectId: seedProject.id,
      input: createWorkflowPayload,
    });
    const workflow = await updateWorkflow({
      workflowId: seedWorkflows[0].id,
      input: { name: "Updated Workflow" },
    });

    assert.equal(workflow.name, "Updated Workflow");
    assert.deepEqual(requests, [
      {
        url: `/api/projects/${encodeURIComponent(seedProject.id)}/workflows`,
        method: "GET",
      },
      {
        url: `/api/projects/${encodeURIComponent(seedProject.id)}/workflows`,
        method: "POST",
        body: JSON.parse(JSON.stringify(createWorkflowPayload)),
      },
      {
        url: `/api/workflows/${encodeURIComponent(seedWorkflows[0].id)}`,
        method: "PATCH",
        body: { name: "Updated Workflow" },
      },
    ]);
  });

  it("exports and imports workflow files through project workflow endpoints", async () => {
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
        data:
          request.url.includes("/export")
            ? {
                workflow: seedWorkflows[0],
                format: "json",
                fileName: "feature-development-loop.json",
                path: "feature-development-loop.json",
                absolutePath: "/tmp/workflows/feature-development-loop.json",
                overwritten: false,
                exportedAt: "2026-06-16T00:00:00.000Z",
              }
            : {
                status: "imported",
                workflow: seedWorkflows[0],
                path: "feature-development-loop.json",
                validationErrors: [],
              },
      });
    };

    const exported = await exportWorkflow({
      workflowId: seedWorkflows[0].id,
      fileName: "feature-development-loop.json",
      overwrite: true,
    });
    const imported = await importProjectWorkflow({
      projectId: seedProject.id,
      path: "feature-development-loop.json",
      overwriteWorkflowId: seedWorkflows[0].id,
    });

    assert.equal(exported.fileName, "feature-development-loop.json");
    assert.equal(imported.status, "imported");
    assert.deepEqual(requests, [
      {
        url: `/api/workflows/${encodeURIComponent(seedWorkflows[0].id)}/export`,
        method: "POST",
        body: {
          fileName: "feature-development-loop.json",
          overwrite: true,
        },
      },
      {
        url: `/api/projects/${encodeURIComponent(seedProject.id)}/workflows/import`,
        method: "POST",
        body: {
          path: "feature-development-loop.json",
          overwriteWorkflowId: seedWorkflows[0].id,
        },
      },
    ]);
  });

  it("starts and advances workflow runs through runner endpoints", async () => {
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
        data: {
          id: "workflow-run-client",
          workflowId: seedWorkflows[0].id,
          projectId: seedProject.id,
          status: request.url.includes("/actions") ? "paused" : "running",
          currentNodeId: "node-human-input",
          inputArtifacts: [],
          outputArtifacts: [],
          executionLogs: [],
          steps: [],
          createdAt: "2026-06-16T00:00:00.000Z",
          updatedAt: "2026-06-16T00:00:00.000Z",
        },
      });
    };

    const started = await startWorkflowRun({
      workflowId: seedWorkflows[0].id,
      featureId: seedFeatures[0].id,
    });
    const advanced = await applyWorkflowRunAction({
      runId: started.id,
      action: "run-next",
    });
    const failed = await applyWorkflowRunAction({
      runId: started.id,
      action: "fail",
      error: "Manual failure",
    });

    assert.equal(started.status, "running");
    assert.equal(advanced.status, "paused");
    assert.equal(failed.id, started.id);
    assert.deepEqual(requests, [
      {
        url: `/api/workflows/${encodeURIComponent(seedWorkflows[0].id)}/runs`,
        method: "POST",
        body: {
          featureId: seedFeatures[0].id,
        },
      },
      {
        url: "/api/workflow-runs/workflow-run-client/actions?action=run-next",
        method: "POST",
        body: { action: "run-next" },
      },
      {
        url: "/api/workflow-runs/workflow-run-client/actions?action=fail",
        method: "POST",
        body: { action: "fail", error: "Manual failure" },
      },
    ]);
  });

  it("posts task open actions to the task open endpoint", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
      });

      return Response.json({
        ok: true,
        data: {
          action: "open-worktree-vscode",
          taskId: seedTasks[0].id,
          projectId: seedProject.id,
          path: "/tmp/worktree",
          pathKind: "worktree",
          usedFallback: false,
          command: "code",
          message: "Opening task worktree in VS Code.",
        },
      });
    };

    const result = await openTask({
      taskId: seedTasks[0].id,
      action: "open-worktree-vscode",
    });

    assert.equal(result.pathKind, "worktree");
    assert.deepEqual(requests, [
      {
        url: `/api/tasks/${encodeURIComponent(seedTasks[0].id)}/open`,
        body: { action: "open-worktree-vscode" },
      },
    ]);
  });

  it("runs the browser project management workflow through stable endpoints", async () => {
    const createdProject = {
      ...seedProject,
      id: "project-browser-flow",
      name: "Browser Flow",
      repoPath: "/tmp/browser-flow",
      isGitRepository: true,
      currentBranch: "feature/browser-flow",
      defaultBranch: "main",
      githubRemoteUrl: "https://github.com/owner/browser-flow",
      specsPath: "specs",
      tasksPath: "docs/tasks",
      workflowsPath: ".github/workflows",
      handoffsPath: "handoffs",
    };
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

      if (request.method === "DELETE") {
        return Response.json({ ok: true, data: { projectId: createdProject.id } });
      }

      return Response.json({
        ok: true,
        data: request.method === "GET" ? [createdProject] : createdProject,
      });
    };

    await fetchProjects();
    await createProject({
      name: "Browser Flow",
      repoPath: "/tmp/browser-flow",
      specsPath: "specs",
      tasksPath: "docs/tasks",
      workflowsPath: ".github/workflows",
      handoffsPath: "handoffs",
    });
    await updateProject({
      projectId: createdProject.id,
      input: { name: "Browser Flow Updated", specsPath: "specs/v2" },
    });
    await deleteProject(createdProject.id);

    assert.deepEqual(requests, [
      {
        url: "/api/projects",
        method: "GET",
      },
      {
        url: "/api/projects",
        method: "POST",
        body: {
          name: "Browser Flow",
          repoPath: "/tmp/browser-flow",
          specsPath: "specs",
          tasksPath: "docs/tasks",
          workflowsPath: ".github/workflows",
          handoffsPath: "handoffs",
        },
      },
      {
        url: `/api/projects/${encodeURIComponent(createdProject.id)}`,
        method: "PATCH",
        body: { name: "Browser Flow Updated", specsPath: "specs/v2" },
      },
      {
        url: `/api/projects/${encodeURIComponent(createdProject.id)}`,
        method: "DELETE",
      },
    ]);
  });

  it("posts feature create and update requests to stable endpoints", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
      });

      return Response.json({
        ok: true,
        data: seedFeatures[0],
      });
    };

    await createFeature({
      projectId: seedProject.id,
      name: "Artifact Flow",
      artifactFolderPath: "specs/artifact-flow",
    });
    await updateFeature({
      featureId: seedFeatures[0].id,
      input: { status: "plan-approved" },
    });

    assert.deepEqual(requests, [
      {
        url: "/api/features",
        body: {
          projectId: seedProject.id,
          name: "Artifact Flow",
          artifactFolderPath: "specs/artifact-flow",
        },
      },
      {
        url: `/api/features/${encodeURIComponent(seedFeatures[0].id)}`,
        body: { status: "plan-approved" },
      },
    ]);
  });

  it("posts feature approval requests to the manual approval endpoint", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
      });

      return Response.json({
        ok: true,
        data: {
          ...seedFeatures[0],
          status: "spec-approved",
          events: [
            {
              id: "feature-kanban-control-plane-spec-approved",
              featureId: seedFeatures[0].id,
              type: "SPEC_APPROVED",
              actor: "human",
              message: "Marked spec artifact approved.",
              createdAt: "2026-06-15T00:00:00.000Z",
              fromStatus: "spec-review",
              toStatus: "spec-approved",
            },
          ],
        },
      });
    };

    const feature = await approveFeatureArtifact({
      featureId: seedFeatures[0].id,
      artifactName: "spec",
    });

    assert.equal(feature.status, "spec-approved");
    assert.deepEqual(requests, [
      {
        url: `/api/features/${encodeURIComponent(seedFeatures[0].id)}/approvals`,
        body: { artifactName: "spec" },
      },
    ]);
  });

  it("loads and saves feature artifact documents through feature artifact endpoints", async () => {
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
        data: {
          featureId: seedFeatures[0].id,
          artifactName: "spec",
          fileName: "spec.md",
          path: seedFeatures[0].specPath,
          absolutePath: `/repo/${seedFeatures[0].specPath}`,
          exists: true,
          content: "# Spec\n",
          loadedAt: "2026-06-15T00:00:00.000Z",
        },
      });
    };

    await fetchFeatureArtifactDocument({
      featureId: seedFeatures[0].id,
      artifactName: "spec",
    });
    await saveFeatureArtifactDocument({
      featureId: seedFeatures[0].id,
      artifactName: "spec",
      content: "# Updated Spec\n",
    });

    assert.deepEqual(requests, [
      {
        url: `/api/features/${encodeURIComponent(seedFeatures[0].id)}/artifacts/spec`,
        method: "GET",
      },
      {
        url: `/api/features/${encodeURIComponent(seedFeatures[0].id)}/artifacts/spec`,
        method: "PUT",
        body: { content: "# Updated Spec\n" },
      },
    ]);
  });

  it("previews and imports Spec Kit tasks through feature-scoped endpoints", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
      });

      const preview = {
        project: seedProject,
        feature: seedFeatures[0],
        tasksPath: seedFeatures[0].tasksPath,
        tasks: [
          {
            sourceId: "T001",
            sourceLine: 12,
            completed: false,
            headings: ["Tasks"],
            title: "Build importer preview",
            description: "Add editable preview controls.",
            fileReferences: ["app/page.tsx"],
            dependencies: [],
            acceptanceCriteria: ["Preview can be imported."],
            labels: ["frontend"],
            owner: "unassigned",
            mode: "execute",
            risk: "medium",
            notes: [],
            sourceText: "- [ ] T001 Build importer preview",
            sourceArtifactPaths: [seedFeatures[0].tasksPath],
            duplicate: false,
          },
        ],
        artifacts: [],
        warnings: [],
        missingArtifacts: [],
      };

      return Response.json({
        ok: true,
        data: String(input).endsWith("/import")
          ? {
              project: seedProject,
              feature: seedFeatures[0],
              imported: [{ task: seedTasks[0], sourceId: "T001" }],
              skipped: [],
              preview,
            }
          : preview,
      });
    };

    await previewSpecKitTasks(seedFeatures[0].id);
    await importSpecKitTasks({
      featureId: seedFeatures[0].id,
      tasks: [
        {
          include: true,
          sourceId: "T001",
          title: "Build importer preview",
          status: "ready",
        },
      ],
    });

    assert.deepEqual(requests, [
      {
        url: `/api/features/${encodeURIComponent(seedFeatures[0].id)}/spec-kit-tasks/preview`,
        body: {},
      },
      {
        url: `/api/features/${encodeURIComponent(seedFeatures[0].id)}/spec-kit-tasks/import`,
        body: {
          tasks: [
            {
              include: true,
              sourceId: "T001",
              title: "Build importer preview",
              status: "ready",
            },
          ],
        },
      },
    ]);
  });

  it("runs the browser feature artifact workflow through stable endpoints", async () => {
    const linkedFeature = {
      ...seedFeatures[0],
      id: "feature-browser-artifacts",
      projectId: seedProject.id,
      name: "Browser Artifacts",
      artifactFolderPath: "specs/browser-artifacts",
      specPath: "specs/browser-artifacts/spec.md",
      status: "spec-review" as const,
      artifacts: {
        ...seedFeatures[0].artifacts,
        spec: {
          ...seedFeatures[0].artifacts.spec,
          path: "specs/browser-artifacts/spec.md",
          exists: true,
          approved: false,
        },
      },
    };
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

      if (request.url.endsWith("/artifacts/spec") && request.method === "GET") {
        return Response.json({
          ok: true,
          data: {
            featureId: linkedFeature.id,
            artifactName: "spec",
            fileName: "spec.md",
            path: linkedFeature.specPath,
            absolutePath: `/repo/${linkedFeature.specPath}`,
            exists: true,
            content: "# Spec\n",
            loadedAt: "2026-06-15T00:00:00.000Z",
          },
        });
      }

      if (request.url.endsWith("/artifacts/spec") && request.method === "PUT") {
        return Response.json({
          ok: true,
          data: {
            featureId: linkedFeature.id,
            artifactName: "spec",
            fileName: "spec.md",
            path: linkedFeature.specPath,
            absolutePath: `/repo/${linkedFeature.specPath}`,
            exists: true,
            content: "# Updated Spec\n",
            loadedAt: "2026-06-15T00:01:00.000Z",
          },
        });
      }

      if (request.url.endsWith("/approvals")) {
        return Response.json({
          ok: true,
          data: {
            ...linkedFeature,
            status: "spec-approved",
            artifacts: {
              ...linkedFeature.artifacts,
              spec: { ...linkedFeature.artifacts.spec, approved: true },
            },
          },
        });
      }

      return Response.json({
        ok: true,
        data: request.method === "GET" ? [linkedFeature] : linkedFeature,
      });
    };

    await fetchFeatures(seedProject.id);
    await createFeature({
      projectId: seedProject.id,
      name: "Browser Artifacts",
      artifactFolderPath: "specs/browser-artifacts",
      source: "spec-kit",
      status: "spec-review",
    });
    await updateFeature({
      featureId: linkedFeature.id,
      input: { artifactFolderPath: "specs/browser-artifacts-v2" },
    });
    await fetchFeatureArtifactDocument({
      featureId: linkedFeature.id,
      artifactName: "spec",
    });
    await saveFeatureArtifactDocument({
      featureId: linkedFeature.id,
      artifactName: "spec",
      content: "# Updated Spec\n",
    });
    await approveFeatureArtifact({
      featureId: linkedFeature.id,
      artifactName: "spec",
    });
    await deleteFeature(linkedFeature.id);

    assert.deepEqual(requests, [
      {
        url: `/api/features?projectId=${encodeURIComponent(seedProject.id)}`,
        method: "GET",
      },
      {
        url: "/api/features",
        method: "POST",
        body: {
          projectId: seedProject.id,
          name: "Browser Artifacts",
          artifactFolderPath: "specs/browser-artifacts",
          source: "spec-kit",
          status: "spec-review",
        },
      },
      {
        url: `/api/features/${encodeURIComponent(linkedFeature.id)}`,
        method: "PATCH",
        body: { artifactFolderPath: "specs/browser-artifacts-v2" },
      },
      {
        url: `/api/features/${encodeURIComponent(linkedFeature.id)}/artifacts/spec`,
        method: "GET",
      },
      {
        url: `/api/features/${encodeURIComponent(linkedFeature.id)}/artifacts/spec`,
        method: "PUT",
        body: { content: "# Updated Spec\n" },
      },
      {
        url: `/api/features/${encodeURIComponent(linkedFeature.id)}/approvals`,
        method: "POST",
        body: { artifactName: "spec" },
      },
      {
        url: `/api/features/${encodeURIComponent(linkedFeature.id)}`,
        method: "DELETE",
      },
    ]);
  });

  it("surfaces friendly API error messages", async () => {
    globalThis.fetch = async () =>
      Response.json({
        ok: false,
        error: {
          code: "validation_error",
          message: "Task action is not supported.",
        },
      });

    await assert.rejects(
      () =>
        applyPersistedTaskAction({
          taskId: "task-local-persistence-reset",
          action: "assign-ai",
        }),
      (error) =>
        error instanceof LoopBoardApiError &&
        error.code === "validation_error" &&
        error.message === "Task action is not supported.",
    );
  });
});
