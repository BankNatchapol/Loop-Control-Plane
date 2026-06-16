import {
  defaultExecutorConfig,
  EXECUTOR_CONFIG_KEY,
  readExecutorConfig,
  validateExecutorConfig,
  type ExecutorConfig,
} from "@/lib/engine/loop-engine-types";
import {
  defaultExecutorConfigForNodeType,
  isWorkflowApprovalGateNode,
} from "@/lib/engine/workflow-node-executor-map";
import type { WorkflowNode } from "@/lib/loopboard";

const legacyCommandFromConfig = (
  config: Record<string, unknown>,
): string | undefined => {
  if (typeof config.command === "string" && config.command.trim().length > 0) {
    return config.command.trim();
  }

  return undefined;
};

const mergeLegacyShellHints = (
  config: Record<string, unknown>,
  executor: ExecutorConfig,
): ExecutorConfig => {
  const legacyCommand = legacyCommandFromConfig(config);
  if (!legacyCommand || executor.command) {
    return executor;
  }

  return {
    ...executor,
    command: legacyCommand,
  };
};

export const resolveWorkflowNodeExecutorConfig = (
  node: Pick<WorkflowNode, "type" | "config">,
): ExecutorConfig => {
  const explicit = readExecutorConfig(node.config);
  if (explicit) {
    return mergeLegacyShellHints(node.config, explicit);
  }

  const defaults = defaultExecutorConfigForNodeType(node.type);
  if (defaults) {
    return mergeLegacyShellHints(node.config, defaults);
  }

  return mergeLegacyShellHints(node.config, defaultExecutorConfig("stub"));
};

export const workflowNodeConfigHasExecutor = (
  config: Record<string, unknown>,
): boolean => {
  if (config[EXECUTOR_CONFIG_KEY] !== undefined) {
    return true;
  }

  return isExecutorBackendShaped(config);
};

const isExecutorBackendShaped = (config: Record<string, unknown>): boolean =>
  typeof config.backend === "string";

export const normalizeWorkflowNodeConfig = (
  config: Record<string, unknown>,
  nodeType: string,
): Record<string, unknown> => {
  if (isWorkflowApprovalGateNode(nodeType)) {
    return config;
  }

  if (workflowNodeConfigHasExecutor(config)) {
    const executor = readExecutorConfig(config);
    if (executor) {
      return {
        ...config,
        [EXECUTOR_CONFIG_KEY]: executor,
      };
    }
  }

  const defaults = defaultExecutorConfigForNodeType(nodeType);
  if (!defaults) {
    return config;
  }

  return {
    ...config,
    [EXECUTOR_CONFIG_KEY]: mergeLegacyShellHints(config, defaults),
  };
};

export const parseWorkflowNodeExecutorConfig = (
  node: Pick<WorkflowNode, "type" | "config">,
) => validateExecutorConfig(resolveWorkflowNodeExecutorConfig(node));
