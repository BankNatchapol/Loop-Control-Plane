import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { POST as postStartScheduler } from "@/app/api/engine/start/route";
import { POST as postTickEngine } from "@/app/api/engine/tick/route";
import { applyMigrations } from "@/db/migrate";
import { seedDatabase } from "@/db/seed";
import {
  buildEngineJobDetail,
  getEngineJobDetail,
  summarizeEngineJob,
} from "@/lib/api/engine-actions";
import { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import { redactEngineLogEntry } from "@/lib/engine/loop-scheduler";
import { scanTaskLoopCandidates } from "@/lib/engine/task-loop-planner";
import { seedProject, seedTasks } from "@/lib/loopboard";
import {
  assertEnginePolicyAllowed,
  describeEffectiveAutomationPolicy,
  EnginePolicyError,
  evaluateEnginePolicy,
  isWorkflowHardStopNode,
} from "@/lib/policies/automation-policy";

type ApiPayload<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

const readApiJson = async <T>(response: Response): Promise<ApiPayload<T>> =>
  (await response.json()) as ApiPayload<T>;

const withRepository = (
  test: (repository: LoopBoardRepository) => void | Promise<void>,
) => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "loop-engine-security-"));
  const databasePath = join(tempDirectory, "loopboard.sqlite");
  const originalDatabasePath = process.env.LOOPBOARD_DATABASE_PATH;
  const database = new DatabaseSync(databasePath);

  return (async () => {
    try {
      process.env.LOOPBOARD_DATABASE_PATH = databasePath;
      applyMigrations(database);
      seedDatabase(database);
      await test(new LoopBoardRepository(database));
    } finally {
      if (originalDatabasePath === undefined) {
        delete process.env.LOOPBOARD_DATABASE_PATH;
      } else {
        process.env.LOOPBOARD_DATABASE_PATH = originalDatabasePath;
      }
      database.close();
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  })();
};

const secretFixtures = [
  {
    label: "GitHub token env assignment",
    value: "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234567890",
  },
  {
    label: "Bearer authorization header",
    value: "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload",
  },
  {
    label: "OpenAI-style API key",
    value: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456",
  },
  {
    label: "AO secret assignment",
    value: "AO_SECRET=super-secret-orchestrator-value",
  },
  {
    label: "PEM private key block",
    value: `-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAsecret\n-----END RSA PRIVATE KEY-----`,
  },
];

describe("loop engine security and policy integration", () => {
  it("requires global auto-run for scheduler control and auto-advance", () => {
    const schedulerPolicy = evaluateEnginePolicy({ operation: "scheduler-control" });
    assert.equal(schedulerPolicy.kind, "deny");
    assert.equal(schedulerPolicy.code, "engine_global_auto_run_required");

    const autoAdvancePolicy = evaluateEnginePolicy({
      operation: "auto-advance",
      engineSettings: { autoAdvanceEnabled: true },
    });
    assert.equal(autoAdvancePolicy.kind, "deny");
    assert.equal(autoAdvancePolicy.code, "engine_auto_advance_global_required");

    assert.throws(
      () =>
        assertEnginePolicyAllowed({
          operation: "scheduler-control",
        }),
      (error: unknown) => {
        assert.ok(error instanceof EnginePolicyError);
        assert.equal(error.code, "engine_global_auto_run_required");
        return true;
      },
    );
  });

  it("blocks project auto-advance when disabled even with global auto-run", () => {
    const policy = evaluateEnginePolicy({
      operation: "auto-advance",
      automationSettings: { globalAutoRunEnabled: true },
      engineSettings: { autoAdvanceEnabled: false },
    });

    assert.equal(policy.kind, "deny");
    assert.equal(policy.code, "engine_auto_advance_project_disabled");
  });

  it("blocks automated pickup for high and critical risk tasks", () =>
    withRepository((repository) => {
      repository.updateAutomationSettings({ globalAutoRunEnabled: true });
      repository.updateProject(seedProject.id, {
        automationPolicy: {
          ...seedProject.automationPolicy,
          allowLowRiskAutoTaskExecution: true,
        },
      });

      const highRiskTask = repository.createTask({
        ...seedTasks[0],
        id: "task-engine-high-risk-ready",
        title: "High risk ready task",
        status: "ready",
        owner: "unassigned",
        risk: "high",
      });
      const criticalRiskTask = repository.createTask({
        ...seedTasks[0],
        id: "task-engine-critical-risk-ready",
        title: "Critical risk ready task",
        status: "ready",
        owner: "unassigned",
        risk: "critical",
      });

      const highPolicy = evaluateEnginePolicy({
        operation: "automated-task-pickup",
        task: highRiskTask,
        automationSettings: { globalAutoRunEnabled: true },
        projectPolicy: repository.getProject(seedProject.id).automationPolicy,
      });
      const criticalPolicy = evaluateEnginePolicy({
        operation: "automated-task-pickup",
        task: criticalRiskTask,
        automationSettings: { globalAutoRunEnabled: true },
        projectPolicy: repository.getProject(seedProject.id).automationPolicy,
      });

      assert.equal(highPolicy.kind, "deny");
      assert.equal(highPolicy.code, "engine_high_risk_task_auto_blocked");
      assert.equal(criticalPolicy.kind, "deny");
      assert.equal(criticalPolicy.code, "engine_critical_risk_task_auto_blocked");

      const scan = scanTaskLoopCandidates(repository, {
        projectId: seedProject.id,
        automated: true,
      });

      assert.equal(
        scan.skipped.some((skip) => skip.taskId === highRiskTask.id),
        true,
      );
      assert.equal(
        scan.skipped.some((skip) => skip.taskId === criticalRiskTask.id),
        true,
      );
      assert.equal(scan.eligible.some((candidate) => candidate.taskId === highRiskTask.id), false);
    }));

  it("blocks automated workflow steps for manual-only, merge, and high-risk nodes", () => {
    const mergePolicy = evaluateEnginePolicy({
      operation: "automated-workflow-step",
      node: {
        type: "merge",
        name: "Merge PR",
        mode: "human",
        requireApproval: true,
        riskPolicy: "manual-only",
        config: {},
      },
      automationSettings: { globalAutoRunEnabled: true },
    });
    const manualOnlyPolicy = evaluateEnginePolicy({
      operation: "automated-workflow-step",
      node: {
        type: "open-pr",
        name: "Open PR",
        mode: "auto",
        requireApproval: false,
        riskPolicy: "manual-only",
        config: {},
      },
      automationSettings: { globalAutoRunEnabled: true },
    });
    const highRiskPolicy = evaluateEnginePolicy({
      operation: "automated-workflow-step",
      node: {
        type: "ai-review",
        name: "AI Review",
        mode: "auto",
        requireApproval: false,
        riskPolicy: "high",
        config: {},
      },
      automationSettings: { globalAutoRunEnabled: true },
    });

    assert.equal(mergePolicy.kind, "deny");
    assert.equal(mergePolicy.code, "engine_workflow_merge_blocked");
    assert.equal(manualOnlyPolicy.kind, "deny");
    assert.equal(manualOnlyPolicy.code, "engine_workflow_manual_only_blocked");
    assert.equal(highRiskPolicy.kind, "deny");
    assert.equal(highRiskPolicy.code, "engine_workflow_high_risk_blocked");
    assert.equal(isWorkflowHardStopNode({ type: "merge", mode: "human" }), true);
  });

  it("surfaces engine automation gates in effective policy summaries", () => {
    const disabled = describeEffectiveAutomationPolicy({
      automationSettings: { globalAutoRunEnabled: false },
      projectPolicy: seedProject.automationPolicy,
      engineSettings: { autoAdvanceEnabled: false },
    });
    const enabled = describeEffectiveAutomationPolicy({
      automationSettings: { globalAutoRunEnabled: true },
      projectPolicy: seedProject.automationPolicy,
      engineSettings: { autoAdvanceEnabled: true },
    });

    assert.equal(disabled.kind, "deny");
    assert.equal(disabled.code, "engine_global_auto_run_required");
    assert.ok(disabled.reasons.some((reason) => reason.includes("auto-advance")));
    assert.ok(
      disabled.reasons.some((reason) =>
        reason.includes("High/critical risk tasks"),
      ),
    );

    assert.equal(enabled.kind, "allow");
    assert.equal(enabled.code, "engine_automation_policy_active");
    assert.ok(enabled.reasons.some((reason) => reason.includes("Global auto-run is enabled")));
  });

  it("redacts secrets from engine job payloads, logs, summaries, and exported detail JSON", () =>
    withRepository((repository) => {
      for (const fixture of secretFixtures) {
        const job = repository.createEngineJob({
          id: `engine-job-secret-${fixture.label.replace(/\s+/gu, "-").toLowerCase()}`,
          kind: "task-run",
          backend: "stub",
          projectId: seedProject.id,
          payload: { note: fixture.value },
          executionLogs: [
            redactEngineLogEntry({
              timestamp: "2026-06-16T12:00:00.000Z",
              level: "error",
              message: fixture.value,
              metadata: { stderrSummary: fixture.value },
            }),
          ],
          result: {
            stdoutSummary: fixture.value,
            stderrSummary: fixture.value,
          },
          error: fixture.value,
        });

        const summary = summarizeEngineJob(job);
        const detail = getEngineJobDetail(repository, job.id);
        const exported = JSON.stringify(buildEngineJobDetail(job, repository));

        assert.doesNotMatch(JSON.stringify(summary), /ghp_[A-Za-z0-9_]{20,}/u);
        assert.doesNotMatch(JSON.stringify(detail.payloadSummary), /ghp_[A-Za-z0-9_]{20,}/u);
        assert.doesNotMatch(exported, /ghp_[A-Za-z0-9_]{20,}/u);
        assert.doesNotMatch(exported, /sk-[A-Za-z0-9_-]{20,}/u);
        assert.match(exported, /\[redacted\]|redacted-github-token|redacted-api-key|redacted-private-key/u);
        assert.doesNotMatch(summary.error ?? "", /super-secret-orchestrator-value/u);
      }
    }));

  it("denies engine API routes when global auto-run is disabled", async () => {
    await withRepository(async () => {
      const startResponse = await postStartScheduler();
      const startPayload = await readApiJson<unknown>(startResponse);
      assert.equal(startResponse.status, 403);
      assert.equal(startPayload.ok, false);
      if (!startPayload.ok) {
        assert.equal(startPayload.error.code, "engine_global_auto_run_required");
      }

      const databasePath = process.env.LOOPBOARD_DATABASE_PATH!;
      const database = new DatabaseSync(databasePath);
      database
        .prepare(
          `
            UPDATE engine_scheduler_state
            SET status = 'running', updated_at = ?
            WHERE id = 'default'
          `,
        )
        .run(new Date().toISOString());
      database.close();

      const tickResponse = await postTickEngine(
        new Request("http://localhost/api/engine/tick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "automated" }),
        }),
      );
      const tickPayload = await readApiJson<unknown>(tickResponse);

      assert.equal(tickResponse.status, 403);
      assert.equal(tickPayload.ok, false);
      if (!tickPayload.ok) {
        assert.equal(tickPayload.error.code, "engine_global_auto_run_required");
      }
    });
  });
});
