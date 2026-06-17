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

const SPEC_KIT_AGENT_COMMANDS: Record<string, string> = {
  spec: "/speckit.specify",
  plan: "/speckit.plan",
  tasks: "/speckit.tasks",
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

export const buildSpecKitAgentPrompt = (input: {
  backend: string;
  actions: string[];
  briefPath: string;
  briefContent: string;
  outputArtifacts: WorkflowArtifact[];
}): string => {
  const integration =
    input.backend === "claude-code"
      ? "claude"
      : input.backend === "cursor"
        ? "cursor"
        : input.backend === "codex"
          ? "codex"
          : input.backend;
  const actionLines = input.actions
    .map((action) => {
      const command = SPEC_KIT_AGENT_COMMANDS[action] ?? `/speckit.${action}`;
      const skill = `speckit-${action === "spec" ? "specify" : action}`;
      const outputArtifact = resolveOutputArtifact(action, input.outputArtifacts);
      const outputPath = outputArtifact?.path ?? `(no output path configured for ${action})`;

      return `- ${command} or ${skill}: produce/update ${outputPath}`;
    })
    .join("\n");
  const outputLines = input.outputArtifacts
    .map(
      (artifact) =>
        `- ${artifact.name}: ${artifact.path}${artifact.required ? " (required)" : ""}`,
    )
    .join("\n");

  return [
    "You are running the Spec Kit Actions workflow step for Loop Control Plane.",
    "",
    "Use GitHub Spec Kit the normal way: through the installed agent commands or skills, not direct specify spec, specify plan, or specify tasks CLI subcommands.",
    `Target integration/backend: ${integration}.`,
    "",
    "If this repository is not initialized as a Spec Kit project, initialize it first with:",
    `specify init --here --integration ${integration} --force`,
    "",
    "Run or faithfully apply these Spec Kit phases in order:",
    actionLines,
    "",
    "If slash commands are not directly executable in this CLI session, read the installed Spec Kit command or skill templates from the .specify directory and the agent integration folder, then perform the same work manually.",
    "",
    "Required output artifacts:",
    outputLines,
    "",
    `Feature brief path: ${input.briefPath}`,
    "",
    "Feature brief:",
    input.briefContent.trim(),
    "",
    "Finish only after the required artifact files exist at the paths above. Keep content concrete and implementation-ready, but do not implement application code during this step.",
  ].join("\n");
};

export const verifySpecKitOutputArtifacts = (input: {
  projectRepoPath: string;
  outputArtifacts: WorkflowArtifact[];
}): { ok: true; outputArtifacts: WorkflowArtifact[] } | { ok: false; missing: WorkflowArtifact[] } => {
  const missing = input.outputArtifacts.filter(
    (artifact) =>
      artifact.required && !artifactExistsOnDisk(input.projectRepoPath, artifact.path),
  );

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  return {
    ok: true,
    outputArtifacts: input.outputArtifacts.filter((artifact) =>
      artifact.required
        ? artifactExistsOnDisk(input.projectRepoPath, artifact.path)
        : true,
    ),
  };
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

  // Fail fast if the brief file doesn't exist on disk — avoids burning retries on a bad path.
  if (!artifactExistsOnDisk(input.projectRepoPath, briefArtifact.path)) {
    return {
      success: false,
      errorCode: "spec_kit_brief_not_found",
      error: `Feature brief not found on disk at "${briefArtifact.path}" (under ${input.projectRepoPath}). Create or upload the brief in the Features tab first.`,
      logs: [
        logEntry("error", "Feature brief file does not exist on disk.", {
          briefPath: briefArtifact.path,
          projectRepoPath: input.projectRepoPath,
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

  if (!input.processRunner) {
    return {
      success: false,
      errorCode: "spec_kit_requires_agent_backend",
      error:
        "Spec Kit Actions must use an agent backend such as cursor, codex, or claude-code. The modern specify CLI does not provide direct spec/plan/tasks subcommands.",
      logs: [
        ...logs,
        logEntry("error", "Spec Kit Actions requires an agent backend.", {
          actions,
          supportedBackends: ["cursor", "codex", "claude-code"],
        }),
      ],
    };
  }

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
