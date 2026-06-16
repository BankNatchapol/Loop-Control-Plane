import type { EngineRunLogEntry } from "@/lib/engine/loop-engine-types";
import {
  findWorkflowArtifactByName,
  markWorkflowArtifactUntrusted,
  resolveWorkflowArtifactPlaceholders,
} from "@/lib/engine/executors/workflow-artifact-paths";
import type { WorkflowStepExecutorResult } from "@/lib/engine/executors/workflow-step-types";
import {
  ProcessRunner,
  defaultProcessRunner,
  type ProcessRunPolicyContext,
  type ProcessRunResult,
} from "@/lib/engine/process-runner";
import type { WorkflowArtifact } from "@/lib/loopboard";
import { sanitizeExternalSummary } from "@/lib/security/safe-context";

export type RunTestsProcessRunner = {
  run: (request: Parameters<ProcessRunner["run"]>[0]) => Promise<ProcessRunResult>;
};

export type RunTestsExecutorInput = {
  projectRepoPath: string;
  workflowRunId: string;
  featureId?: string;
  inputArtifacts: WorkflowArtifact[];
  outputArtifacts: WorkflowArtifact[];
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  processRunner?: RunTestsProcessRunner;
  policy?: ProcessRunPolicyContext;
};

const nowIso = (): string => new Date().toISOString();

const logEntry = (
  level: EngineRunLogEntry["level"],
  message: string,
  metadata: EngineRunLogEntry["metadata"] = {},
): EngineRunLogEntry => ({
  timestamp: nowIso(),
  level,
  message,
  metadata,
});

const summarizeTestReport = (processResult: ProcessRunResult): string => {
  const sections = [
    `Command: ${processResult.commandSummary}`,
    `Exit code: ${processResult.exitCode ?? "unknown"}`,
    processResult.timedOut ? "Timed out: yes" : undefined,
    processResult.stdoutSummary
      ? `Stdout summary:\n${processResult.stdoutSummary}`
      : undefined,
    processResult.stderrSummary
      ? `Stderr summary:\n${processResult.stderrSummary}`
      : undefined,
  ].filter((section): section is string => Boolean(section));

  return sanitizeExternalSummary(sections.join("\n\n")) ?? "Test run produced no output.";
};

export const executeRunTests = async (
  input: RunTestsExecutorInput,
): Promise<WorkflowStepExecutorResult> => {
  const testReportArtifact = findWorkflowArtifactByName(input.outputArtifacts, [
    "test-report",
  ]);

  if (!testReportArtifact) {
    return {
      success: false,
      errorCode: "run_tests_output_missing",
      error: "Run tests requires a test-report output artifact.",
      logs: [
        logEntry("error", "Test report output artifact was not configured.", {
          workflowRunId: input.workflowRunId,
        }),
      ],
    };
  }

  const runner = input.processRunner ?? defaultProcessRunner;
  const args = input.args && input.args.length > 0 ? input.args : ["test"];
  const cwd = input.cwd ?? input.projectRepoPath;
  const logs: EngineRunLogEntry[] = [
    logEntry("info", "Run tests executor started.", {
      workflowRunId: input.workflowRunId,
      args,
      cwd,
    }),
  ];

  let processResult: ProcessRunResult;
  try {
    processResult = await runner.run({
      profile: "npm-test",
      args,
      cwd,
      projectRepoPath: input.projectRepoPath,
      timeoutMs: input.timeoutMs,
      policy: input.policy,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Test process execution failed.";
    return {
      success: false,
      errorCode: "run_tests_process_failed",
      error: message,
      logs: [...logs, logEntry("error", message, { args })],
    };
  }

  logs.push(
    logEntry(
      processResult.success ? "info" : "error",
      processResult.success ? "Project tests passed." : "Project tests failed.",
      {
        exitCode: processResult.exitCode,
        timedOut: processResult.timedOut,
        commandSummary: processResult.commandSummary,
        stdoutSummary: processResult.stdoutSummary,
        stderrSummary: processResult.stderrSummary,
      },
    ),
  );

  const testReportSummary = summarizeTestReport(processResult);
  const resolvedArtifact = markWorkflowArtifactUntrusted(
    resolveWorkflowArtifactPlaceholders(testReportArtifact, {
      run: input.workflowRunId,
      feature: input.featureId ?? "project",
    }),
    "Test command stdout and stderr are external process output and untrusted.",
  );

  if (!processResult.success) {
    return {
      success: false,
      errorCode: processResult.timedOut ? "run_tests_timeout" : "run_tests_failed",
      error: processResult.timedOut
        ? "Project test command timed out."
        : `Project test command exited with code ${processResult.exitCode ?? "unknown"}.`,
      outputArtifacts: [resolvedArtifact],
      result: {
        workflowRunId: input.workflowRunId,
        testReportPath: resolvedArtifact.path,
        testReportSummary,
        exitCode: processResult.exitCode,
        timedOut: processResult.timedOut,
        passed: false,
      },
      logs,
    };
  }

  return {
    success: true,
    outputArtifacts: [resolvedArtifact],
    result: {
      workflowRunId: input.workflowRunId,
      testReportPath: resolvedArtifact.path,
      testReportSummary,
      exitCode: processResult.exitCode,
      timedOut: processResult.timedOut,
      passed: true,
    },
    logs: [
      ...logs,
      logEntry("info", "Run tests executor completed.", {
        testReportPath: resolvedArtifact.path,
      }),
    ],
  };
};
