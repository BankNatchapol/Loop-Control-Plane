import {
  EXECUTOR_BACKENDS,
  withExecutorConfig,
  type ExecutorBackend,
} from "@/lib/engine/loop-engine-types";
import { resolveWorkflowNodeExecutorConfig } from "@/lib/engine/workflow-node-config";
import {
  getWorkflowNodeExecutorMapping,
  workflowNodeTypesWithEngineExecutors,
} from "@/lib/engine/workflow-node-executor-map";
import type { WorkflowNode, WorkflowRunStep } from "@/lib/loopboard";
import {
  isShellCapableWorkflowNode,
  workflowNodeShellWarning,
} from "@/lib/policies/automation-policy";

const BUILT_IN_EXECUTOR_NODE_TYPES = new Set([
  "import-tasks",
  "create-github-issues",
  "run-tests",
  "open-pr",
  "merge",
]);

export const workflowExecutorBackendOptions = (
  nodeType?: string,
): readonly ExecutorBackend[] => {
  if (nodeType && BUILT_IN_EXECUTOR_NODE_TYPES.has(nodeType)) {
    return ["stub"];
  }

  if (nodeType === "spec-kit-actions") {
    return ["cursor", "claude-code", "codex"];
  }

  if (nodeType === "agent-orchestrator-implement") {
    return ["agent-orchestrator"];
  }

  return EXECUTOR_BACKENDS;
};

export const workflowExecutorBackendLabel = (
  backend: ExecutorBackend,
  nodeType?: string,
): string => {
  if (backend === "stub" && nodeType === "spec-kit-actions") {
    return "stub (unsupported)";
  }

  if (backend === "stub") {
    return "stub (built-in)";
  }

  return backend;
};

export const isAutomatableWorkflowNodeType = (nodeType: string): boolean =>
  workflowNodeTypesWithEngineExecutors().includes(
    nodeType as ReturnType<typeof workflowNodeTypesWithEngineExecutors>[number],
  );

export const AO_AGENT_PLUGIN_OPTIONS = [
  { value: "claude-code", label: "Claude Code", defaultModel: "claude-sonnet-4-6" },
  { value: "codex",       label: "Codex",       defaultModel: "gpt-5.5"           },
  { value: "cursor",      label: "Cursor",       defaultModel: "composer-2.5"      },
] as const;

export const AO_AGENT_PLUGIN_DEFAULT = "claude-code";

export const aoAgentPluginLabel = (plugin?: string): string =>
  AO_AGENT_PLUGIN_OPTIONS.find(
    (option) => option.value === (plugin || AO_AGENT_PLUGIN_DEFAULT),
  )?.label ?? plugin ?? "Claude Code";

export type ExecutorEditorState = {
  automatable: boolean;
  backend: ExecutorBackend;
  argsText: string;
  timeoutMs: string;
  model: string;
  fanOutMaxConcurrency: string;
  fanOutIssueIdsText: string;
  aoAgentPlugin: string;
  aoAgentModels: Record<string, string>;
  defaultBackend: ExecutorBackend;
};

export const formatExecutorArgs = (args?: string[]): string =>
  (args ?? []).join(", ");

export const parseExecutorArgs = (value: string): string[] =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

export const formatFanOutIssueIds = (issueIds?: number[]): string =>
  (issueIds ?? []).join(", ");

export const parseFanOutIssueIds = (value: string): number[] =>
  value
    .split(/[,\s]+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => Number.parseInt(entry, 10))
    .filter((entry) => Number.isInteger(entry) && entry > 0);

export const readExecutorEditorState = (
  node: Pick<WorkflowNode, "type" | "config">,
): ExecutorEditorState => {
  const mapping = getWorkflowNodeExecutorMapping(node.type);
  const executor = resolveWorkflowNodeExecutorConfig(node);

  return {
    automatable: isAutomatableWorkflowNodeType(node.type),
    backend: executor.backend,
    argsText: formatExecutorArgs(executor.args),
    timeoutMs:
      executor.timeoutMs !== undefined ? String(executor.timeoutMs) : "",
    model: executor.model ?? "",
    fanOutMaxConcurrency:
      executor.fanOut?.maxConcurrency !== undefined
        ? String(executor.fanOut.maxConcurrency)
        : "",
    fanOutIssueIdsText: formatFanOutIssueIds(executor.fanOut?.issueIds),
    aoAgentPlugin: executor.aoAgentPlugin ?? AO_AGENT_PLUGIN_DEFAULT,
    aoAgentModels: executor.aoAgentModels ?? {},
    defaultBackend: mapping?.defaultBackend ?? "stub",
  };
};

export const applyExecutorEditorPatch = (
  node: Pick<WorkflowNode, "type" | "config">,
  patch: {
    backend?: ExecutorBackend;
    argsText?: string;
    timeoutMs?: string;
    model?: string;
    fanOutMaxConcurrency?: string;
    fanOutIssueIdsText?: string;
    aoAgentPlugin?: string;
    aoAgentModels?: Record<string, string>;
  },
): Record<string, unknown> => {
  const current = resolveWorkflowNodeExecutorConfig(node);
  const next = {
    ...current,
    ...(patch.backend !== undefined ? { backend: patch.backend } : {}),
    ...(patch.argsText !== undefined
      ? { args: parseExecutorArgs(patch.argsText) }
      : {}),
    ...(patch.timeoutMs !== undefined
      ? {
          timeoutMs:
            patch.timeoutMs.trim().length === 0
              ? undefined
              : Math.max(1, Number.parseInt(patch.timeoutMs, 10) || 0),
        }
      : {}),
    ...(patch.model !== undefined
      ? {
          model: patch.model.trim().length === 0 ? undefined : patch.model.trim(),
        }
      : {}),
    ...(patch.aoAgentPlugin !== undefined
      ? {
          aoAgentPlugin:
            patch.aoAgentPlugin.trim().length === 0 ||
            patch.aoAgentPlugin.trim() === AO_AGENT_PLUGIN_DEFAULT
              ? undefined
              : patch.aoAgentPlugin.trim(),
        }
      : {}),
    ...(patch.aoAgentModels !== undefined
      ? {
          aoAgentModels:
            Object.keys(patch.aoAgentModels).length === 0 ? undefined : patch.aoAgentModels,
        }
      : {}),
  };

  if (
    patch.fanOutMaxConcurrency !== undefined ||
    patch.fanOutIssueIdsText !== undefined
  ) {
    const maxConcurrencyText =
      patch.fanOutMaxConcurrency ?? String(current.fanOut?.maxConcurrency ?? "");
    const issueIdsText =
      patch.fanOutIssueIdsText ?? formatFanOutIssueIds(current.fanOut?.issueIds);
    const maxConcurrency = Number.parseInt(maxConcurrencyText.trim(), 10);
    const issueIds = parseFanOutIssueIds(issueIdsText);

    if (
      maxConcurrencyText.trim().length === 0 &&
      issueIdsText.trim().length === 0
    ) {
      next.fanOut = undefined;
    } else if (
      Number.isInteger(maxConcurrency) &&
      maxConcurrency > 0 &&
      issueIds.length > 0
    ) {
      next.fanOut = {
        maxConcurrency,
        issueIds,
      };
    }
  }

  return withExecutorConfig(node.config, next);
};

export const workflowNodeExecutorPolicyWarnings = (
  node: Pick<WorkflowNode, "type" | "mode" | "requireApproval" | "config">,
): string[] => {
  const warnings: string[] = [];

  if (
    node.mode === "auto" &&
    !node.requireApproval &&
    isShellCapableWorkflowNode(node)
  ) {
    warnings.push(
      `${workflowNodeShellWarning} Auto mode without approval is blocked until approval is enabled or mode is changed.`,
    );
  }

  return warnings;
};

export const workflowNodeExecutorRuntimeHint = (
  node: Pick<WorkflowNode, "type">,
  executor: Pick<ExecutorEditorState, "backend">,
): string | undefined => {
  if (node.type === "spec-kit-actions" && executor.backend === "stub") {
    return "Spec Kit Actions needs an agent backend. Choose cursor, codex, or claude-code so the agent can run the normal /speckit commands.";
  }

  if (executorBackendSupportsModel(executor.backend)) {
    return "Model applies to new engine jobs for this node. Existing queued jobs keep the executor config they were created with.";
  }

  if (executorBackendSupportsFanOut(executor.backend)) {
    return "AO workflow jobs enter through the built-in dispatcher; spawned AO workers use the Agent selected below. Saved changes apply to new workflow runs because active runs use a pinned snapshot.";
  }

  return undefined;
};

export const extractEngineJobIdFromWorkflowStep = (
  step?: WorkflowRunStep,
): string | undefined => {
  if (!step) {
    return undefined;
  }

  for (const entry of [...step.executionLogs].reverse()) {
    const engineJobId = entry.metadata?.engineJobId;
    if (typeof engineJobId === "string" && engineJobId.trim().length > 0) {
      return engineJobId.trim();
    }
  }

  return undefined;
};

export const executorBackendSupportsModel = (backend: ExecutorBackend): boolean =>
  backend === "cursor" || backend === "claude-code" || backend === "codex";

export const executorBackendSupportsFanOut = (backend: ExecutorBackend): boolean =>
  backend === "agent-orchestrator";

/** Node types where the agent plugin (cursor / codex / claude-code) is configurable. */
const AGENT_PLUGIN_NODE_TYPES = new Set([
  "agent-orchestrator-implement",
  "ai-review",
  "pr-review-agent",
]);

export const workflowNodeSupportsAgentPlugin = (nodeType: string): boolean =>
  AGENT_PLUGIN_NODE_TYPES.has(nodeType);
