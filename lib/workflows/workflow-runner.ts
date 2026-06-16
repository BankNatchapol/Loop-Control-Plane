import type { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import { UnsupportedTransitionError, ValidationError } from "@/lib/db/loopboard-repository";
import type { EngineJob } from "@/lib/engine/loop-engine-types";
import { resolveWorkflowNodeExecutorConfig } from "@/lib/engine/workflow-node-config";
import { resolveWorkflowArtifactPath } from "@/lib/engine/executors/workflow-artifact-paths";
import {
  isEngineDelegatedWorkflowNode,
  parseWorkflowArtifacts,
} from "@/lib/engine/executors/workflow-step-types";
import type {
  Workflow,
  WorkflowArtifact,
  WorkflowLogEntry,
  WorkflowNode,
  WorkflowRun,
  WorkflowRunStep,
} from "@/lib/loopboard";
import { evaluateWorkflowNodePolicy } from "@/lib/policies/automation-policy";

export type WorkflowRunAction =
  | "start"
  | "run-next"
  | "approve"
  | "skip-disabled"
  | "fail"
  | "resume";

export type StartWorkflowRunInput = {
  workflowId: string;
  featureId?: string;
  inputArtifacts?: WorkflowArtifact[];
};

export type WorkflowRunnerActionInput = {
  action: WorkflowRunAction;
  error?: string;
};

const secretPatterns = [
  /(token|secret|password|authorization|api[_-]?key)=([^,\s]+)/gi,
  /(bearer\s+)[a-z0-9._-]+/gi,
];

const redact = (value: string): string =>
  secretPatterns.reduce(
    (current, pattern) => current.replace(pattern, "$1[redacted]"),
    value,
  );

const logEntry = (
  level: WorkflowLogEntry["level"],
  message: string,
  metadata: WorkflowLogEntry["metadata"] = {},
): WorkflowLogEntry => ({
  timestamp: new Date().toISOString(),
  level,
  message: redact(message),
  metadata,
});

const appendLog = (
  logs: WorkflowLogEntry[],
  level: WorkflowLogEntry["level"],
  message: string,
  metadata: WorkflowLogEntry["metadata"] = {},
): WorkflowLogEntry[] => [...logs, logEntry(level, message, metadata)];

const resolveArtifactPath = resolveWorkflowArtifactPath;

const enqueueEngineDelegatedWorkflowStep = ({
  repository,
  workflow,
  run,
  node,
  existingStep,
  approvedAt,
}: {
  repository: LoopBoardRepository;
  workflow: Workflow;
  run: WorkflowRun;
  node: WorkflowNode;
  existingStep?: WorkflowRunStep;
  approvedAt?: string;
}): WorkflowRun => {
  const now = new Date().toISOString();
  const attempt = (existingStep?.attempt ?? 0) + 1;
  const executorConfig = resolveWorkflowNodeExecutorConfig(node);
  const inputArtifacts = node.inputArtifacts.map((artifact) =>
    resolveArtifactPath({ artifact, workflow, run }),
  );
  const outputArtifacts = node.outputArtifacts.map((artifact) =>
    resolveArtifactPath({ artifact, workflow, run }),
  );

  const job = repository.createEngineJob({
    kind: "workflow-step",
    backend: executorConfig.backend,
    projectId: run.projectId,
    workflowRunId: run.id,
    workflowNodeId: node.id,
    maxAttempts: Math.max(node.maxRetries + 1, 1),
    payload: {
      workflowRunId: run.id,
      workflowNodeId: node.id,
      nodeType: node.type,
      featureId: run.featureId,
      executor: executorConfig,
      inputArtifacts,
      outputArtifacts,
    },
    executionLogs: [
      {
        timestamp: now,
        level: "info",
        message: `Workflow step "${node.name}" enqueued for engine execution.`,
        metadata: {
          workflowRunId: run.id,
          workflowNodeId: node.id,
          nodeType: node.type,
        },
      },
    ],
  });

  return repository.upsertWorkflowRunStep(run.id, {
    id: existingStep?.id,
    workflowNodeId: node.id,
    status: "running",
    attempt,
    inputArtifacts,
    outputArtifacts: [],
    executionLogs: appendLog(
      existingStep?.executionLogs ?? stepLogsForNode({ node, action: "enqueued engine job" }),
      "info",
      `${node.name} enqueued engine job ${job.id}.`,
      { nodeId: node.id, engineJobId: job.id, nodeType: node.type },
    ),
    requireApproval: existingStep?.requireApproval ?? node.requireApproval,
    approvedAt: approvedAt ?? existingStep?.approvedAt,
    startedAt: existingStep?.startedAt ?? now,
    updatedAt: now,
  });
};

const firstRunnableNodeId = (workflow: Workflow): string | undefined => {
  const targetIds = new Set(workflow.edges.map((edge) => edge.targetNodeId));
  return (
    workflow.nodes.find((node) => !targetIds.has(node.id)) ?? workflow.nodes[0]
  )?.id;
};

const normalizeBranchLabel = (label: string): string => label.trim().toLowerCase();

const nextNodeId = (
  workflow: Workflow,
  nodeId: string,
  branchLabel?: string,
): string | undefined => {
  const outgoing = workflow.edges.filter((edge) => edge.sourceNodeId === nodeId);
  if (outgoing.length === 0) {
    return undefined;
  }

  if (branchLabel) {
    const normalized = normalizeBranchLabel(branchLabel);
    const matched = outgoing.find(
      (edge) => normalizeBranchLabel(edge.label) === normalized,
    );
    if (matched) {
      return matched.targetNodeId;
    }
  }

  const unlabeled = outgoing.find((edge) => edge.label.trim().length === 0);
  return (unlabeled ?? outgoing[0])?.targetNodeId;
};

const findCurrentNode = (workflow: Workflow, run: WorkflowRun): WorkflowNode => {
  const nodeId = run.currentNodeId ?? firstRunnableNodeId(workflow);
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);

  if (!node) {
    throw new ValidationError("Workflow run current node was not found.");
  }

  return node;
};

const latestStepForNode = (
  run: WorkflowRun,
  nodeId: string,
): WorkflowRunStep | undefined =>
  [...run.steps].reverse().find((step) => step.workflowNodeId === nodeId);

const stepLogsForNode = ({
  node,
  action,
}: {
  node: WorkflowNode;
  action: string;
}): WorkflowLogEntry[] => [
  logEntry("info", `${node.name} ${action}.`, {
    nodeId: node.id,
    nodeType: node.type,
    mode: node.mode,
    inputArtifacts: node.inputArtifacts.length,
    outputArtifacts: node.outputArtifacts.length,
  }),
];

const workflowEventMetadata = ({
  workflow,
  run,
  node,
  step,
}: {
  workflow: Workflow;
  run: WorkflowRun;
  node: WorkflowNode;
  step?: WorkflowRunStep;
}): Record<string, string | number | boolean | null> => ({
  workflowId: workflow.id,
  workflowRunId: run.id,
  workflowNodeId: node.id,
  workflowNodeType: node.type,
  workflowStepId: step?.id ?? null,
  workflowStepStatus: step?.status ?? null,
});

const artifactTargetsTask = (
  artifact: WorkflowArtifact,
  task: ReturnType<LoopBoardRepository["getTask"]>,
): boolean => {
  const haystack = [
    artifact.name,
    artifact.path,
    artifact.description ?? "",
  ].join("\n");

  return (
    haystack.includes(task.id) ||
    task.handoff.contextPaths.some((path) => path && haystack.includes(path)) ||
    Boolean(task.github.issueUrl && haystack.includes(task.github.issueUrl)) ||
    Boolean(
      task.github.pullRequestUrl && haystack.includes(task.github.pullRequestUrl),
    )
  );
};

const linkCompletedStepToContext = ({
  repository,
  workflow,
  run,
  node,
  step,
}: {
  repository: LoopBoardRepository;
  workflow: Workflow;
  run: WorkflowRun;
  node: WorkflowNode;
  step: WorkflowRunStep;
}): void => {
  const metadata = workflowEventMetadata({ workflow, run, node, step });
  const timestamp = step.completedAt ?? step.updatedAt;

  if (run.featureId) {
    repository.appendFeatureEvent(run.featureId, {
      type: "WORKFLOW_STEP_COMPLETED",
      actor: "system",
      message: `Workflow step "${node.name}" completed for this feature.`,
      createdAt: timestamp,
      metadata,
    });
  }

  const artifacts = [...step.inputArtifacts, ...step.outputArtifacts];
  const tasks = repository
    .listBoardData(run.projectId)
    .tasks.filter(
      (task) =>
        task.featureId === run.featureId &&
        (artifacts.some((artifact) => artifactTargetsTask(artifact, task)) ||
          (node.type === "import-tasks" && task.source === "spec-kit") ||
          (node.type === "create-github-issues" && Boolean(task.github.issueUrl)) ||
          (node.type === "open-pr" && Boolean(task.github.pullRequestUrl))),
    );

  for (const task of tasks) {
    repository.appendTaskEvent(task.id, {
      type: "WORKFLOW_STEP_COMPLETED",
      actor: "system",
      message: `Workflow step "${node.name}" completed for this task.`,
      createdAt: timestamp,
      metadata,
    });
  }
};

const assertActionableRun = (run: WorkflowRun): void => {
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    throw new UnsupportedTransitionError(
      `Workflow run "${run.id}" cannot be changed after reaching ${run.status}.`,
    );
  }
};

const updateAfterNode = ({
  repository,
  workflow,
  run,
  node,
  logs,
  branchLabel,
}: {
  repository: LoopBoardRepository;
  workflow: Workflow;
  run: WorkflowRun;
  node: WorkflowNode;
  logs: WorkflowLogEntry[];
  branchLabel?: string;
}): WorkflowRun => {
  const nextId = nextNodeId(workflow, node.id, branchLabel);
  const now = new Date().toISOString();

  return repository.updateWorkflowRun(run.id, {
    status: nextId ? "running" : "completed",
    currentNodeId: nextId ?? null,
    executionLogs: appendLog(
      logs,
      "info",
      nextId ? `Workflow advanced to ${nextId}.` : "Workflow run completed.",
      {
        nodeId: node.id,
        nextNodeId: nextId ?? null,
        branchLabel: branchLabel ?? null,
      },
    ),
    completedAt: nextId ? null : now,
    updatedAt: now,
  });
};

export type CompleteWorkflowStepFromEngineJobInput = {
  repository: LoopBoardRepository;
  job: EngineJob;
  success: boolean;
  error?: string;
  outputArtifacts?: WorkflowArtifact[];
  branchLabel?: string;
};

export const completeWorkflowStepFromEngineJob = ({
  repository,
  job,
  success,
  error,
  outputArtifacts,
  branchLabel,
}: CompleteWorkflowStepFromEngineJobInput): WorkflowRun | undefined => {
  if (
    job.kind !== "workflow-step" ||
    !job.workflowRunId ||
    !job.workflowNodeId
  ) {
    return undefined;
  }

  const run = repository.getWorkflowRun(job.workflowRunId);
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    return run;
  }

  const workflow = repository.getWorkflow(run.workflowId);
  const node = workflow.nodes.find((candidate) => candidate.id === job.workflowNodeId);
  if (!node) {
    return undefined;
  }

  const existingStep = latestStepForNode(run, node.id);
  if (!existingStep || existingStep.status !== "running") {
    return run;
  }

  const now = new Date().toISOString();
  const resolvedBranchLabel =
    branchLabel ??
    (typeof job.result?.branchLabel === "string" ? job.result.branchLabel : undefined);
  const resolvedOutputs =
    (outputArtifacts && outputArtifacts.length > 0 ? outputArtifacts : undefined) ??
    parseWorkflowArtifacts(job.result?.outputArtifacts) ??
    node.outputArtifacts.map((artifact) =>
      resolveArtifactPath({ artifact, workflow, run }),
    );

  if (!success) {
    const failureMessage = redact(error ?? job.error ?? "Engine workflow step failed.");
    const failedRun = repository.upsertWorkflowRunStep(run.id, {
      id: existingStep.id,
      workflowNodeId: node.id,
      status: "failed",
      attempt: existingStep.attempt,
      inputArtifacts: existingStep.inputArtifacts,
      outputArtifacts: existingStep.outputArtifacts,
      executionLogs: appendLog(
        existingStep.executionLogs,
        "error",
        `${node.name} failed after engine job ${job.id}: ${failureMessage}`,
        { nodeId: node.id, engineJobId: job.id },
      ),
      error: failureMessage,
      requireApproval: existingStep.requireApproval,
      approvedAt: existingStep.approvedAt,
      startedAt: existingStep.startedAt,
      completedAt: now,
      updatedAt: now,
    });

    return repository.updateWorkflowRun(run.id, {
      status: "failed",
      currentNodeId: node.id,
      executionLogs: appendLog(failedRun.executionLogs, "error", failureMessage, {
        nodeId: node.id,
        engineJobId: job.id,
      }),
      completedAt: now,
      updatedAt: now,
    });
  }

  const steppedRun = repository.upsertWorkflowRunStep(run.id, {
    id: existingStep.id,
    workflowNodeId: node.id,
    status: "completed",
    attempt: existingStep.attempt,
    inputArtifacts: existingStep.inputArtifacts,
    outputArtifacts: resolvedOutputs,
    executionLogs: appendLog(
      existingStep.executionLogs,
      "info",
      `${node.name} completed via engine job ${job.id}.`,
      {
        nodeId: node.id,
        engineJobId: job.id,
        branchLabel: resolvedBranchLabel ?? null,
      },
    ),
    requireApproval: existingStep.requireApproval,
    approvedAt: existingStep.approvedAt,
    startedAt: existingStep.startedAt,
    completedAt: now,
    updatedAt: now,
  });
  const completedStep = steppedRun.steps.find((candidate) => candidate.id === existingStep.id);

  if (completedStep) {
    linkCompletedStepToContext({
      repository,
      workflow,
      run: steppedRun,
      node,
      step: completedStep,
    });
  }

  return updateAfterNode({
    repository,
    workflow,
    run: steppedRun,
    node,
    logs: steppedRun.executionLogs,
    branchLabel: resolvedBranchLabel,
  });
};

export const startWorkflowRun = ({
  repository,
  input,
}: {
  repository: LoopBoardRepository;
  input: StartWorkflowRunInput;
}): WorkflowRun => {
  const workflow = repository.getWorkflow(input.workflowId);
  const currentNodeId = firstRunnableNodeId(workflow);

  if (!currentNodeId) {
    throw new ValidationError("Workflow must include at least one node to start a run.");
  }

  const now = new Date().toISOString();
  const run = repository.createWorkflowRun({
    workflowId: workflow.id,
    projectId: workflow.projectId,
    featureId: input.featureId,
    status: "running",
    currentNodeId,
    inputArtifacts: input.inputArtifacts ?? [],
    executionLogs: [
      logEntry("info", "Workflow run started.", {
        workflowId: workflow.id,
        projectId: workflow.projectId,
        featureId: input.featureId ?? null,
        currentNodeId,
      }),
    ],
    startedAt: now,
    createdAt: now,
  });

  if (run.featureId) {
    repository.appendFeatureEvent(run.featureId, {
      type: "WORKFLOW_RUN_STARTED",
      actor: "system",
      message: `Workflow "${workflow.name}" started for this feature.`,
      createdAt: now,
      metadata: {
        workflowId: workflow.id,
        workflowRunId: run.id,
        currentNodeId,
      },
    });
  }

  return run;
};

export const runNextWorkflowStep = ({
  repository,
  runId,
}: {
  repository: LoopBoardRepository;
  runId: string;
}): WorkflowRun => {
  const run = repository.getWorkflowRun(runId);
  assertActionableRun(run);

  if (run.status === "paused") {
    throw new UnsupportedTransitionError(
      "Approve or resume the paused workflow run before running the next step.",
    );
  }

  const workflow = repository.getWorkflow(run.workflowId);
  const project = repository.getProject(run.projectId);
  const node = findCurrentNode(workflow, run);
  const now = new Date().toISOString();
  const existingStep = latestStepForNode(run, node.id);

  if (existingStep?.status === "running") {
    throw new UnsupportedTransitionError(
      "Wait for the running engine job to finish before running the next step.",
    );
  }

  if (existingStep?.status === "waiting-approval") {
    throw new UnsupportedTransitionError(
      "Approve the waiting workflow step before running the next step.",
    );
  }

  if (node.mode === "disabled") {
    const skippedRun = repository.upsertWorkflowRunStep(run.id, {
      workflowNodeId: node.id,
      status: "skipped",
      attempt: (existingStep?.attempt ?? 0) + 1,
      inputArtifacts: node.inputArtifacts,
      outputArtifacts: [],
      executionLogs: stepLogsForNode({ node, action: "was skipped because it is disabled" }),
      requireApproval: false,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    });

    return updateAfterNode({
      repository,
      workflow,
      run: skippedRun,
      node,
      logs: skippedRun.executionLogs,
    });
  }

  const policy = evaluateWorkflowNodePolicy({
    node,
    automated: node.mode === "auto",
    automationSettings: repository.getAutomationSettings(),
    projectPolicy: project.automationPolicy,
  });

  if (policy.kind === "requires-approval" || policy.kind === "deny") {
    repository.upsertWorkflowRunStep(run.id, {
      workflowNodeId: node.id,
      status: "waiting-approval",
      attempt: (existingStep?.attempt ?? 0) + 1,
      inputArtifacts: node.inputArtifacts,
      outputArtifacts: [],
      executionLogs: stepLogsForNode({ node, action: "is waiting for approval" }),
      requireApproval: true,
      startedAt: now,
      updatedAt: now,
    });

    return repository.updateWorkflowRun(run.id, {
      status: "paused",
      currentNodeId: node.id,
      executionLogs: appendLog(
        run.executionLogs,
        "warn",
        policy.kind === "deny"
          ? `Workflow paused because policy denied automatic execution: ${policy.message}`
          : `Workflow paused for approval: ${policy.message}`,
        {
          nodeId: node.id,
          mode: node.mode,
          policyCode: policy.code,
          policyRisk: policy.effectiveRisk ?? null,
          policyReasons: policy.reasons.join("; "),
        },
      ),
      updatedAt: now,
    });
  }

  if (isEngineDelegatedWorkflowNode(node.type)) {
    const delegatedRun = enqueueEngineDelegatedWorkflowStep({
      repository,
      workflow,
      run,
      node,
      existingStep,
    });

    return repository.updateWorkflowRun(run.id, {
      status: "running",
      currentNodeId: node.id,
      executionLogs: appendLog(
        delegatedRun.executionLogs,
        "info",
        `Engine job queued for ${node.name}.`,
        { nodeId: node.id, nodeType: node.type },
      ),
      updatedAt: now,
    });
  }

  const outputArtifacts = node.outputArtifacts.map((artifact) =>
    resolveArtifactPath({ artifact, workflow, run }),
  );
  const steppedRun = repository.upsertWorkflowRunStep(run.id, {
    workflowNodeId: node.id,
    status: "completed",
    attempt: (existingStep?.attempt ?? 0) + 1,
    inputArtifacts: node.inputArtifacts,
    outputArtifacts,
    executionLogs: stepLogsForNode({ node, action: "completed deterministically" }),
    requireApproval: false,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  });
  const completedStep = steppedRun.steps.at(-1);

  if (completedStep) {
    linkCompletedStepToContext({
      repository,
      workflow,
      run: steppedRun,
      node,
      step: completedStep,
    });
  }

  return updateAfterNode({
    repository,
    workflow,
    run: steppedRun,
    node,
    logs: steppedRun.executionLogs,
  });
};

export const approveWorkflowRunStep = ({
  repository,
  runId,
}: {
  repository: LoopBoardRepository;
  runId: string;
}): WorkflowRun => {
  const run = repository.getWorkflowRun(runId);
  assertActionableRun(run);

  const workflow = repository.getWorkflow(run.workflowId);
  const node = findCurrentNode(workflow, run);
  const step = latestStepForNode(run, node.id);

  if (!step || step.status !== "waiting-approval") {
    throw new UnsupportedTransitionError(
      "Workflow run does not have a step waiting for approval.",
    );
  }

  const now = new Date().toISOString();
  const outputArtifacts = node.outputArtifacts.map((artifact) =>
    resolveArtifactPath({ artifact, workflow, run }),
  );

  if (isEngineDelegatedWorkflowNode(node.type)) {
    const delegatedRun = enqueueEngineDelegatedWorkflowStep({
      repository,
      workflow,
      run,
      node,
      existingStep: step,
      approvedAt: now,
    });

    return repository.updateWorkflowRun(run.id, {
      status: "running",
      currentNodeId: node.id,
      executionLogs: appendLog(
        delegatedRun.executionLogs,
        "info",
        "Workflow step approved and enqueued for engine execution.",
        { nodeId: node.id, nodeType: node.type },
      ),
      updatedAt: now,
    });
  }

  const steppedRun = repository.upsertWorkflowRunStep(run.id, {
    id: step.id,
    workflowNodeId: node.id,
    status: "completed",
    attempt: step.attempt,
    inputArtifacts: step.inputArtifacts,
    outputArtifacts,
    executionLogs: appendLog(
      step.executionLogs,
      "info",
      `${node.name} approved by a human operator.`,
      { nodeId: node.id },
    ),
    requireApproval: true,
    approvedAt: now,
    completedAt: now,
    updatedAt: now,
  });
  const completedStep = steppedRun.steps.find((candidate) => candidate.id === step.id);

  if (completedStep) {
    linkCompletedStepToContext({
      repository,
      workflow,
      run: steppedRun,
      node,
      step: completedStep,
    });
  }

  return updateAfterNode({
    repository,
    workflow,
    run: steppedRun,
    node,
    logs: appendLog(steppedRun.executionLogs, "info", "Workflow step approved.", {
      nodeId: node.id,
    }),
  });
};

export const skipDisabledWorkflowStep = ({
  repository,
  runId,
}: {
  repository: LoopBoardRepository;
  runId: string;
}): WorkflowRun => {
  const run = repository.getWorkflowRun(runId);
  const workflow = repository.getWorkflow(run.workflowId);
  const node = findCurrentNode(workflow, run);

  if (node.mode !== "disabled") {
    throw new UnsupportedTransitionError(
      "Only disabled workflow nodes can be skipped with this action.",
    );
  }

  return runNextWorkflowStep({ repository, runId });
};

export const failWorkflowRunStep = ({
  repository,
  runId,
  error = "Workflow step failed.",
}: {
  repository: LoopBoardRepository;
  runId: string;
  error?: string;
}): WorkflowRun => {
  const run = repository.getWorkflowRun(runId);
  assertActionableRun(run);

  const workflow = repository.getWorkflow(run.workflowId);
  const node = findCurrentNode(workflow, run);
  const existingStep = latestStepForNode(run, node.id);
  const now = new Date().toISOString();

  repository.upsertWorkflowRunStep(run.id, {
    id: existingStep?.id,
    workflowNodeId: node.id,
    status: "failed",
    attempt: existingStep?.attempt ?? 1,
    inputArtifacts: existingStep?.inputArtifacts ?? node.inputArtifacts,
    outputArtifacts: existingStep?.outputArtifacts ?? [],
    executionLogs: appendLog(
      existingStep?.executionLogs ?? [],
      "error",
      redact(error),
      { nodeId: node.id },
    ),
    error: redact(error),
    requireApproval: existingStep?.requireApproval ?? node.requireApproval,
    startedAt: existingStep?.startedAt ?? now,
    completedAt: now,
    updatedAt: now,
  });

  return repository.updateWorkflowRun(run.id, {
    status: "failed",
    currentNodeId: node.id,
    executionLogs: appendLog(run.executionLogs, "error", redact(error), {
      nodeId: node.id,
    }),
    completedAt: now,
    updatedAt: now,
  });
};

export const resumeWorkflowRun = ({
  repository,
  runId,
}: {
  repository: LoopBoardRepository;
  runId: string;
}): WorkflowRun => {
  const run = repository.getWorkflowRun(runId);
  assertActionableRun(run);

  if (run.status !== "paused") {
    throw new UnsupportedTransitionError("Only paused workflow runs can be resumed.");
  }

  const workflow = repository.getWorkflow(run.workflowId);
  const node = findCurrentNode(workflow, run);
  const step = latestStepForNode(run, node.id);

  if (step?.status === "waiting-approval") {
    throw new UnsupportedTransitionError(
      "Approve the waiting workflow step before resuming the run.",
    );
  }

  return repository.updateWorkflowRun(run.id, {
    status: "running",
    executionLogs: appendLog(run.executionLogs, "info", "Workflow run resumed.", {
      nodeId: node.id,
    }),
  });
};

export const applyWorkflowRunAction = ({
  repository,
  runId,
  input,
}: {
  repository: LoopBoardRepository;
  runId: string;
  input: WorkflowRunnerActionInput;
}): WorkflowRun => {
  switch (input.action) {
    case "run-next":
      return runNextWorkflowStep({ repository, runId });
    case "approve":
      return approveWorkflowRunStep({ repository, runId });
    case "skip-disabled":
      return skipDisabledWorkflowStep({ repository, runId });
    case "fail":
      return failWorkflowRunStep({ repository, runId, error: input.error });
    case "resume":
      return resumeWorkflowRun({ repository, runId });
    case "start":
      throw new ValidationError("Start workflow runs from the workflow endpoint.");
  }
};
