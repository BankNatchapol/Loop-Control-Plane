import { existsSync } from "node:fs";

import type { EngineRunLogEntry } from "@/lib/engine/loop-engine-types";
import {
  ProcessRunner,
  defaultProcessRunner,
  type ProcessRunPolicyContext,
  type ProcessRunResult,
} from "@/lib/engine/process-runner";

import {
  artifactExistsOnDisk,
  findWorkflowArtifactByName,
  resolveProjectArtifactAbsolutePath,
} from "@/lib/engine/executors/workflow-artifact-paths";
import type { WorkflowStepExecutorResult } from "@/lib/engine/executors/workflow-step-types";

import type { WorkflowArtifact } from "@/lib/loopboard";

export type SpecKitProcessRunner = {
  run: (request: Parameters<ProcessRunner["run"]>[0]) => Promise<ProcessRunResult>;
};

export type SpecKitActionsExecutorInput = {
  projectRepoPath: string;
  cwd?: string;
  inputArtifacts: WorkflowArtifact[];
  outputArtifacts: WorkflowArtifact[];
  actions?: string[];
  timeoutMs?: number;
  processRunner?: SpecKitProcessRunner;
  policy?: ProcessRunPolicyContext;
};

const DEFAULT_SPEC_KIT_ACTIONS = ["spec", "plan", "tasks"] as const;

const ACTION_OUTPUT_NAMES: Record<string, string[]> = {
  spec: ["spec"],
  plan: ["plan"],
  tasks: ["tasks"],
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

const resolveOutputArtifact = (
  action: string,
  outputArtifacts: WorkflowArtifact[],
): WorkflowArtifact | undefined => {
  const names = ACTION_OUTPUT_NAMES[action] ?? [action];
  return findWorkflowArtifactByName(outputArtifacts, names);
};

const resolveInputPathForAction = (
  action: string,
  briefPath: string,
  outputArtifacts: WorkflowArtifact[],
): string => {
  if (action === "spec") {
    return briefPath;
  }

  if (action === "plan") {
    const specArtifact = resolveOutputArtifact("spec", outputArtifacts);
    return specArtifact?.path ?? briefPath;
  }

  if (action === "tasks") {
    const planArtifact = resolveOutputArtifact("plan", outputArtifacts);
    return planArtifact?.path ?? briefPath;
  }

  const priorArtifact = resolveOutputArtifact(action, outputArtifacts);
  return priorArtifact?.path ?? briefPath;
};

const missingOutputError = (
  action: string,
  outputPath: string,
  processResult?: ProcessRunResult,
): WorkflowStepExecutorResult => ({
  success: false,
  errorCode: "spec_kit_output_missing",
  error: `Spec Kit action "${action}" did not produce required output at ${outputPath}.`,
  result: processResult
    ? {
        action,
        exitCode: processResult.exitCode,
        timedOut: processResult.timedOut,
        stdoutSummary: processResult.stdoutSummary,
        stderrSummary: processResult.stderrSummary,
      }
    : { action, outputPath },
  logs: [
    logEntry("error", `Missing Spec Kit output for action "${action}".`, {
      action,
      outputPath,
    }),
  ],
});

export const executeSpecKitActions = async (
  input: SpecKitActionsExecutorInput,
): Promise<WorkflowStepExecutorResult> => {
  const briefArtifact = findWorkflowArtifactByName(input.inputArtifacts, [
    "feature-brief",
    "prd",
  ]);

  if (!briefArtifact) {
    return {
      success: false,
      errorCode: "spec_kit_input_missing",
      error: "Spec Kit actions require a feature brief input artifact.",
      logs: [
        logEntry("error", "Feature brief input artifact was not found.", {
          inputArtifacts: input.inputArtifacts.map((artifact) => artifact.name),
        }),
      ],
    };
  }

  const actions =
    input.actions && input.actions.length > 0
      ? input.actions
      : [...DEFAULT_SPEC_KIT_ACTIONS];
  const runner = input.processRunner ?? defaultProcessRunner;
  const cwd = input.cwd ?? input.projectRepoPath;
  const briefPath = briefArtifact.path;
  const logs: EngineRunLogEntry[] = [
    logEntry("info", "Starting Spec Kit actions executor.", {
      actions,
      briefPath,
    }),
  ];

  for (const action of actions) {
    const outputArtifact = resolveOutputArtifact(action, input.outputArtifacts);
    if (!outputArtifact) {
      return {
        success: false,
        errorCode: "spec_kit_output_artifact_missing",
        error: `No output artifact is configured for Spec Kit action "${action}".`,
        logs: [
          ...logs,
          logEntry("error", `Missing output artifact mapping for action "${action}".`, {
            action,
          }),
        ],
      };
    }

    const inputPath = resolveInputPathForAction(
      action,
      briefPath,
      input.outputArtifacts,
    );
    const outputPath = outputArtifact.path;

    logs.push(
      logEntry("info", `Running Spec Kit action "${action}".`, {
        action,
        inputPath,
        outputPath,
      }),
    );

    let processResult: ProcessRunResult;
    try {
      processResult = await runner.run({
        profile: "spec-kit",
        args: [action, inputPath, outputPath],
        cwd,
        projectRepoPath: input.projectRepoPath,
        timeoutMs: input.timeoutMs,
        policy: input.policy,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Spec Kit process execution failed.";
      return {
        success: false,
        errorCode: "spec_kit_process_failed",
        error: message,
        logs: [
          ...logs,
          logEntry("error", message, { action, inputPath, outputPath }),
        ],
      };
    }

    logs.push(
      logEntry(
        processResult.success ? "info" : "error",
        processResult.success
          ? `Spec Kit action "${action}" completed.`
          : `Spec Kit action "${action}" failed.`,
        {
          action,
          exitCode: processResult.exitCode,
          timedOut: processResult.timedOut,
          commandSummary: processResult.commandSummary,
          stdoutSummary: processResult.stdoutSummary,
          stderrSummary: processResult.stderrSummary,
        },
      ),
    );

    if (!processResult.success) {
      return {
        success: false,
        errorCode: processResult.timedOut
          ? "spec_kit_timeout"
          : "spec_kit_process_failed",
        error: processResult.timedOut
          ? `Spec Kit action "${action}" timed out.`
          : `Spec Kit action "${action}" exited with code ${processResult.exitCode ?? "unknown"}.`,
        result: {
          action,
          exitCode: processResult.exitCode,
          timedOut: processResult.timedOut,
          stdoutSummary: processResult.stdoutSummary,
          stderrSummary: processResult.stderrSummary,
        },
        logs,
      };
    }

    const absoluteOutputPath = resolveProjectArtifactAbsolutePath(
      input.projectRepoPath,
      outputPath,
    );

    if (!existsSync(absoluteOutputPath)) {
      return missingOutputError(action, outputPath, processResult);
    }
  }

  const verifiedOutputs = input.outputArtifacts.filter((artifact) =>
    artifact.required
      ? artifactExistsOnDisk(input.projectRepoPath, artifact.path)
      : true,
  );

  const missingRequired = input.outputArtifacts.filter(
    (artifact) =>
      artifact.required &&
      !artifactExistsOnDisk(input.projectRepoPath, artifact.path),
  );

  if (missingRequired.length > 0) {
    return {
      success: false,
      errorCode: "spec_kit_output_missing",
      error: `Required Spec Kit outputs are missing: ${missingRequired.map((artifact) => artifact.path).join(", ")}.`,
      logs: [
        ...logs,
        logEntry("error", "Required Spec Kit output files were not found.", {
          missing: missingRequired.map((artifact) => artifact.path),
        }),
      ],
    };
  }

  return {
    success: true,
    outputArtifacts: verifiedOutputs.length > 0 ? input.outputArtifacts : undefined,
    result: {
      actions,
      briefPath,
      generatedOutputs: input.outputArtifacts.map((artifact) => artifact.path),
    },
    logs: [
      ...logs,
      logEntry("info", "Spec Kit actions completed and outputs verified.", {
        actions,
        outputCount: input.outputArtifacts.length,
      }),
    ],
  };
};
