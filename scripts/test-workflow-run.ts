#!/usr/bin/env npx tsx
/**
 * End-to-end workflow test.
 * Creates a run for the Feature Development Loop against the Loop Test project,
 * acting as a human operator at all gate nodes and executing real engine steps.
 *
 * Stops before Agent Orchestrator to avoid spawning real agents.
 */

import { openLoopBoardDatabase, applyMigrations } from "@/db/migrate";
import { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import type { WorkflowRun, WorkflowNode } from "@/lib/loopboard";
import {
  startWorkflowRun,
  runNextWorkflowStep,
  approveWorkflowRunStep,
  completeWorkflowStepFromEngineJob,
} from "@/lib/workflows/workflow-runner";
import { dispatchWorkflowStepJob } from "@/lib/engine/executors/workflow-step-dispatcher";
import type { ExecutorContext } from "@/lib/engine/executor-registry";
import {
  artifactExistsOnDisk,
} from "@/lib/engine/executors/workflow-artifact-paths";

// ─── Config ──────────────────────────────────────────────────────────────────

const PROJECT_ID = "project-87b0b590-1854-4387-8c54-a01095667611";
const WORKFLOW_ID = "3a2d96c3-1d93-475b-9e60-940025996e67";
const FEATURE_ID = "portfolio-web-app";

// Stop before these — they spawn external agents or real PRs
const STOP_BEFORE = new Set(["agent-orchestrator-implement", "open-pr", "merge"]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const HR = "═".repeat(62);
const DIV = "─".repeat(62);

function nodeHeader(node: WorkflowNode, status: string) {
  console.log(`\n${HR}`);
  console.log(`📍  ${node.name}  [${node.type}]  mode=${node.mode}  status=${status}`);
  if (node.guidance) {
    const g = node.guidance.slice(0, 120);
    console.log(`    💬 ${g}${node.guidance.length > 120 ? "…" : ""}`);
  }
  console.log(DIV);
}

function latestStepForNode(run: WorkflowRun, nodeId: string) {
  return [...(run.steps ?? [])]
    .filter((s) => s.workflowNodeId === nodeId)
    .sort((a, b) => b.attempt - a.attempt)[0];
}

async function executeEngineJob(
  repository: LoopBoardRepository,
  run: WorkflowRun,
  node: WorkflowNode,
): Promise<WorkflowRun> {
  const jobs = repository.listEngineJobs({
    workflowRunId: run.id,
    workflowNodeId: node.id,
    status: "queued",
  });

  if (jobs.length === 0) {
    console.log(`    ⚠️  No queued engine job found for ${node.name}`);
    return run;
  }

  const job = jobs[0];
  const now = new Date().toISOString();
  console.log(`    🔧 Engine job ${job.id.slice(0, 12)}… (${node.type})`);

  // Mark as running
  repository.updateEngineJob(job.id, { status: "running", startedAt: now });
  const runningJob = repository.getEngineJob(job.id);

  // For spec-kit-actions: the modern specify CLI requires an agent backend.
  // If all output artifacts already exist on disk, treat as success (pre-existing outputs).
  const project = repository.getProject(run.projectId);
  const outputArtifacts = runningJob.payload?.outputArtifacts as Array<{ name: string; path: string }> | undefined;
  const allOutputsExist =
    node.type === "spec-kit-actions" &&
    Array.isArray(outputArtifacts) &&
    outputArtifacts.filter((a) => a.name !== "checklist").every((a) =>
      artifactExistsOnDisk(project.repoPath, a.path),
    );

  if (allOutputsExist) {
    console.log("    ℹ️  Spec Kit outputs already exist on disk — treating as pre-generated.");
    console.log("       (specify v0.10+ requires an agent backend; artifacts are already in place)");
  }

  const context: ExecutorContext = {
    job: runningJob,
    config: { backend: (runningJob.backend as "spec-kit") },
  };

  let result;
  if (allOutputsExist) {
    result = {
      success: true,
      error: undefined as string | undefined,
      result: undefined as Record<string, unknown> | undefined,
      logs: [
        {
          timestamp: new Date().toISOString(),
          level: "info" as const,
          message: "Spec Kit output artifacts verified on disk — skipping regeneration.",
          metadata: {},
        },
      ],
    };
  } else {
    try {
      result = await dispatchWorkflowStepJob(context, { repository });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`    ❌ Dispatcher threw: ${msg}`);
      result = { success: false, error: msg, logs: [] as never[] };
    }
  }

  const icon = result.success ? "✓" : "✗";
  console.log(`    ${icon} ${result.success ? "success" : `failed: ${result.error ?? "unknown"}`}`);

  if (result.logs && result.logs.length > 0) {
    for (const log of (result.logs as Array<{ level: string; message: string }>).slice(-5)) {
      console.log(`      [${log.level}] ${log.message.slice(0, 100)}`);
    }
  }
  if ((result as { stdoutSummary?: string }).stdoutSummary) {
    const out = (result as { stdoutSummary: string }).stdoutSummary;
    console.log(`      stdout: ${out.slice(0, 200)}`);
  }

  // Mark job completed/failed
  const completedJob = repository.updateEngineJob(job.id, {
    status: result.success ? "completed" : "failed",
    completedAt: new Date().toISOString(),
    result: { ...(result.result ?? {}), logs: result.logs ?? [] },
    error: result.error ?? null,
  });

  // Advance the workflow
  const updatedRun = completeWorkflowStepFromEngineJob({
    repository,
    job: completedJob,
    success: result.success,
    error: result.error,
    branchLabel:
      typeof (result.result as Record<string, unknown> | undefined)?.branchLabel === "string"
        ? (result.result as Record<string, unknown>).branchLabel as string
        : undefined,
  });

  return updatedRun ?? run;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${"▓".repeat(62)}`);
  console.log("  Feature Development Loop — End-to-End Test");
  console.log(`${"▓".repeat(62)}`);
  console.log(`  Project : ${PROJECT_ID}`);
  console.log(`  Workflow: ${WORKFLOW_ID}`);
  console.log(`  Feature : ${FEATURE_ID}`);

  const database = openLoopBoardDatabase();
  applyMigrations(database);
  const repository = new LoopBoardRepository(database);

  try {
    // 1. Create or find feature
    let feature;
    try {
      feature = repository.getFeature(FEATURE_ID);
      console.log(`\n✓ Using existing feature: ${feature.name}`);
    } catch {
      feature = repository.createFeature({
        id: FEATURE_ID,
        projectId: PROJECT_ID,
        name: "Portfolio Web App",
        artifactFolderPath: "specs/portfolio-web-app",
        prdPath: "specs/portfolio-web-app/PRD.md",
        specPath: "specs/portfolio-web-app/spec.md",
        planPath: "specs/portfolio-web-app/plan.md",
        tasksPath: "specs/portfolio-web-app/tasks.md",
        status: "prd-draft",
      });
      console.log(`\n✓ Created feature: ${feature.name} (${feature.id})`);
    }

    // 1b. Enable global auto-run so engine executors can create GitHub issues, etc.
    repository.updateAutomationSettings({ globalAutoRunEnabled: true });
    console.log("✓ Enabled globalAutoRunEnabled for test run");

    // 2. Start the workflow run
    let run = startWorkflowRun({
      repository,
      input: { workflowId: WORKFLOW_ID, featureId: FEATURE_ID },
    });
    console.log(`\n✓ Run started: ${run.id}`);

    const workflow = repository.getWorkflow(WORKFLOW_ID);
    let lastNodeId: string | null = null;
    let stepCount = 0;

    // 3. Walk the workflow
    while (run.status === "running" || run.status === "paused") {
      if (++stepCount > 50) {
        console.log("\n⚠️  Step limit (50) reached — stopping.");
        break;
      }

      const node = workflow.nodes.find((n) => n.id === run.currentNodeId);
      if (!node) {
        console.log(`\n❌ Unknown current node: ${run.currentNodeId}`);
        break;
      }

      if (node.id !== lastNodeId) {
        lastNodeId = node.id;
        nodeHeader(node, run.status);
      }

      // Stop before AO / PR / Merge
      if (STOP_BEFORE.has(node.type)) {
        console.log(`\n    ⏸️  Test stops at ${node.name}.`);
        console.log("       In production AO would implement all GitHub issues here.");
        break;
      }

      if (run.status === "paused") {
        console.log("    🧑 Acting as human operator: APPROVE");
        run = approveWorkflowRunStep({ repository, runId: run.id });
        console.log(`    → approved, run status: ${run.status}`);
        continue;
      }

      if (run.status === "running") {
        const latestStep = latestStepForNode(run, node.id);

        if (latestStep?.status === "running") {
          // Engine job is queued — execute it
          run = await executeEngineJob(repository, run, node);
          continue;
        }

        // No step yet or completed — advance to next step
        run = runNextWorkflowStep({ repository, runId: run.id });
        console.log(`    → runNextWorkflowStep → status: ${run.status}`);
        continue;
      }
    }

    // 4. Summary
    const finalNode = workflow.nodes.find((n) => n.id === run.currentNodeId);
    console.log(`\n${HR}`);
    console.log("🏁  Test complete");
    console.log(`    Run ID : ${run.id}`);
    console.log(`    Status : ${run.status}`);
    console.log(`    At node: ${finalNode?.name ?? run.currentNodeId ?? "—"}`);
    console.log(`    Steps  : ${run.steps?.length ?? 0}`);
    if (run.steps && run.steps.length > 0) {
      console.log("\n    Step log:");
      for (const step of run.steps) {
        const stepNode = workflow.nodes.find((n) => n.id === step.workflowNodeId);
        console.log(
          `      [${step.status.padEnd(16)}] ${stepNode?.name ?? step.workflowNodeId} (attempt ${step.attempt})`,
        );
      }
    }
    console.log(HR);
  } finally {
    database.close();
  }
}

main().catch((err) => {
  console.error("\n❌ Test failed:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) {
    console.error(err.stack.split("\n").slice(1, 5).join("\n"));
  }
  process.exit(1);
});
