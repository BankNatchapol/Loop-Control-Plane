import { spawn, spawnSync, type ChildProcess } from "node:child_process";

import {
  evaluateWorkflowNodePolicy,
  type AutomationSettings,
  type PolicyDecision,
} from "@/lib/policies/automation-policy";
import { redactSensitiveText } from "@/lib/security/safe-context";
import {
  LocalCommandError,
  redactSensitiveCommandValue,
  validateLocalDirectory,
} from "@/lib/system/local-command-runner";
import type { ProjectAutomationPolicy, WorkflowNode } from "@/lib/loopboard";

export type ProcessCommandProfile =
  | "spec-kit"
  | "npm-test"
  | "git"
  | "gh"
  | "cursor"
  | "claude"
  | "codex"
  | "ao";

export type ProcessProfileDefinition = {
  profile: ProcessCommandProfile;
  command: string;
  defaultArgs: readonly string[];
  placeholder: boolean;
  discovered?: boolean;
};

export type ProcessRunRequest = {
  profile: ProcessCommandProfile;
  args?: string[];
  cwd: string;
  projectRepoPath: string;
  timeoutMs?: number;
  envAllowlist?: string[];
  signal?: AbortSignal;
};

export type ProcessRunPolicyContext = {
  node: Pick<
    WorkflowNode,
    "type" | "name" | "mode" | "requireApproval" | "riskPolicy" | "config"
  >;
  automated?: boolean;
  approved?: boolean;
  automationSettings?: AutomationSettings;
  projectPolicy?: ProjectAutomationPolicy;
};

export type ProcessRunOptions = ProcessRunRequest & {
  policy?: ProcessRunPolicyContext;
};

export type ProcessRunResult = {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutSummary: string;
  stderrSummary: string;
  timedOut: boolean;
  durationMs: number;
  commandSummary: string;
  profile: ProcessCommandProfile;
  command: string;
  args: string[];
};

export type ProcessSpawnOutcome = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  signal?: NodeJS.Signals | null;
};

export type ProcessSpawner = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal?: AbortSignal;
  },
) => Promise<ProcessSpawnOutcome>;

export class ProcessRunnerError extends Error {
  constructor(
    message: string,
    readonly statusCode = 500,
    readonly code = "process_runner_failed",
    readonly policyDecision?: PolicyDecision,
  ) {
    super(message);
  }
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_OUTPUT_BYTE_LIMIT = 256 * 1024;
const SUMMARY_CHAR_LIMIT = 240;

const SPEC_KIT_CANDIDATES = ["spec-kit", "speckit", "specify"] as const;

const PROFILE_COMMANDS: Record<
  Exclude<ProcessCommandProfile, "spec-kit">,
  Pick<ProcessProfileDefinition, "command" | "defaultArgs" | "placeholder">
> = {
  "npm-test": { command: "npm", defaultArgs: ["test"], placeholder: false },
  git: { command: "git", defaultArgs: [], placeholder: false },
  gh: { command: "gh", defaultArgs: [], placeholder: false },
  cursor: { command: "cursor", defaultArgs: [], placeholder: false },
  claude: { command: "claude", defaultArgs: [], placeholder: false },
  codex: { command: "codex", defaultArgs: [], placeholder: false },
  ao: { command: "ao", defaultArgs: [], placeholder: false },
};

const ALLOWED_COMMANDS = new Set<string>([
  ...Object.values(PROFILE_COMMANDS).map((entry) => entry.command),
  ...SPEC_KIT_CANDIDATES,
]);

const BASE_PROCESS_ENV_KEYS = [
  "NODE_ENV",
  "PATH",
  "SystemRoot",
  "windir",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
] as const;

const DEFAULT_PROCESS_ENV_ALLOWLIST = [...BASE_PROCESS_ENV_KEYS];

const shellMetacharPattern = /[;&|`$<>]/u;

const nowMs = (): number => Date.now();

const truncateBytes = (value: string, limit = DEFAULT_OUTPUT_BYTE_LIMIT): string => {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= limit) {
    return value;
  }

  return buffer.subarray(0, limit).toString("utf8");
};

const summarizeOutput = (value: string): string => {
  const redacted = redactSensitiveText(value.trim());
  if (redacted.length === 0) {
    return "";
  }

  return redacted.length > SUMMARY_CHAR_LIMIT
    ? `${redacted.slice(0, SUMMARY_CHAR_LIMIT - 3)}...`
    : redacted;
};

const buildSafeProcessEnv = (envAllowlist: readonly string[]): NodeJS.ProcessEnv => {
  const env: Record<string, string> = {};

  for (const key of envAllowlist) {
    const value = process.env[key];
    if (typeof value === "string") {
      env[key] = value;
    }
  }

  if (!env.NODE_ENV) {
    env.NODE_ENV = process.env.NODE_ENV ?? "production";
  }

  if (!env.PATH && typeof process.env.PATH === "string") {
    env.PATH = process.env.PATH;
  }

  return env as NodeJS.ProcessEnv;
};

const validateArgs = (args: string[]): void => {
  for (const arg of args) {
    if (typeof arg !== "string") {
      throw new ProcessRunnerError("Process arguments must be strings.", 400, "invalid_args");
    }

    if (arg.includes("\0")) {
      throw new ProcessRunnerError(
        "Process arguments cannot contain null bytes.",
        400,
        "invalid_args",
      );
    }

    if (shellMetacharPattern.test(arg)) {
      throw new ProcessRunnerError(
        "Process arguments cannot contain shell metacharacters.",
        400,
        "shell_metachar_rejected",
      );
    }
  }
};

export const isAllowedProcessCommand = (command: string): boolean =>
  ALLOWED_COMMANDS.has(command);

const assertAllowedCommand = (command: string): void => {
  if (!isAllowedProcessCommand(command)) {
    throw new ProcessRunnerError(
      `Command "${command}" is not on the process-runner allowlist.`,
      400,
      "command_not_allowed",
    );
  }
};

const resolveWorkingDirectory = (
  cwd: string,
  projectRepoPath: string,
): string =>
  validateLocalDirectory({
    path: cwd,
    basePath: projectRepoPath,
    missingCode: "cwd_missing",
    notDirectoryCode: "cwd_not_directory",
    traversalCode: "cwd_traversal_rejected",
  });

export const discoverSpecKitBinary = (
  env: NodeJS.ProcessEnv = buildSafeProcessEnv(DEFAULT_PROCESS_ENV_ALLOWLIST),
): string | undefined => {
  for (const candidate of SPEC_KIT_CANDIDATES) {
    const result = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      env,
      timeout: 2_000,
    });

    if (!result.error && result.status === 0) {
      return candidate;
    }
  }

  return undefined;
};

export const resolveProcessProfile = (
  profile: ProcessCommandProfile,
  env: NodeJS.ProcessEnv = buildSafeProcessEnv(DEFAULT_PROCESS_ENV_ALLOWLIST),
): ProcessProfileDefinition => {
  if (profile === "spec-kit") {
    const discovered = discoverSpecKitBinary(env);
    return {
      profile,
      command: discovered ?? "spec-kit",
      defaultArgs: [],
      placeholder: false,
      discovered: Boolean(discovered),
    };
  }

  const definition = PROFILE_COMMANDS[profile];
  return {
    profile,
    ...definition,
  };
};

export const evaluateProcessRunPolicy = (
  input: ProcessRunPolicyContext,
): PolicyDecision => evaluateWorkflowNodePolicy(input);

export const assertProcessRunPolicyAllowed = (
  input: ProcessRunPolicyContext,
): PolicyDecision => {
  const decision = evaluateProcessRunPolicy(input);

  if (decision.kind === "allow") {
    return decision;
  }

  throw new ProcessRunnerError(
    decision.message,
    decision.kind === "deny" ? 403 : 409,
    decision.code,
    decision,
  );
};

export const buildProcessCommandSummary = (
  command: string,
  args: string[],
): string =>
  [command, ...args.map(redactSensitiveCommandValue)].join(" ");

const defaultProcessSpawner: ProcessSpawner = async (command, args, options) => {
  return new Promise<ProcessSpawnOutcome>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child: ChildProcess = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (outcome: ProcessSpawnOutcome): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };

    const onAbort = (): void => {
      timedOut = true;
      child.kill("SIGTERM");
      finish({
        exitCode: child.exitCode,
        stdout: truncateBytes(stdout),
        stderr: truncateBytes(stderr),
        timedOut: true,
        signal: "SIGTERM",
      });
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = truncateBytes(`${stdout}${chunk.toString("utf8")}`);
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = truncateBytes(`${stderr}${chunk.toString("utf8")}`);
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      finish({
        exitCode,
        stdout: truncateBytes(stdout),
        stderr: truncateBytes(stderr),
        timedOut,
        signal,
      });
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
};

export class ProcessRunner {
  constructor(private readonly spawner: ProcessSpawner = defaultProcessSpawner) {}

  resolveProfile(
    profile: ProcessCommandProfile,
    envAllowlist: readonly string[] = DEFAULT_PROCESS_ENV_ALLOWLIST,
  ): ProcessProfileDefinition {
    return resolveProcessProfile(profile, buildSafeProcessEnv(envAllowlist));
  }

  async run(
    request: ProcessRunOptions,
    spawner: ProcessSpawner = this.spawner,
  ): Promise<ProcessRunResult> {
    if (request.policy) {
      assertProcessRunPolicyAllowed(request.policy);
    }

    const envAllowlist = request.envAllowlist ?? DEFAULT_PROCESS_ENV_ALLOWLIST;
    const env = buildSafeProcessEnv(envAllowlist);
    const profileDefinition = resolveProcessProfile(request.profile, env);
    const command = profileDefinition.command;
    const args = request.args ?? [...profileDefinition.defaultArgs];

    assertAllowedCommand(command);
    validateArgs(args);

    if (request.profile === "spec-kit" && !profileDefinition.discovered) {
      throw new ProcessRunnerError(
        "Spec Kit CLI was not found on PATH. Tried: spec-kit, speckit, specify.",
        404,
        "spec_kit_unavailable",
      );
    }

    if (profileDefinition.placeholder) {
      throw new ProcessRunnerError(
        `Process profile "${request.profile}" is a placeholder and is not enabled yet.`,
        501,
        "process_profile_placeholder",
      );
    }

    let cwd: string;
    try {
      cwd = resolveWorkingDirectory(request.cwd, request.projectRepoPath);
    } catch (error) {
      if (error instanceof LocalCommandError) {
        throw new ProcessRunnerError(error.message, error.statusCode, error.code);
      }

      throw error;
    }

    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = nowMs();

    let outcome: ProcessSpawnOutcome;
    try {
      outcome = await spawner(command, args, {
        cwd,
        env,
        timeoutMs,
        signal: request.signal,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Process spawn failed unexpectedly.";
      throw new ProcessRunnerError(message, 500, "process_spawn_failed");
    }

    const durationMs = nowMs() - startedAt;
    const stdoutSummary = summarizeOutput(outcome.stdout);
    const stderrSummary = summarizeOutput(outcome.stderr);
    const commandSummary = buildProcessCommandSummary(command, args);
    const success = !outcome.timedOut && outcome.exitCode === 0;

    return {
      success,
      exitCode: outcome.exitCode,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      stdoutSummary,
      stderrSummary,
      timedOut: outcome.timedOut,
      durationMs,
      commandSummary: redactSensitiveCommandValue(commandSummary),
      profile: request.profile,
      command,
      args,
    };
  }
}

export const defaultProcessRunner = new ProcessRunner();

export const runProcessProfile = (
  request: ProcessRunOptions,
): Promise<ProcessRunResult> => defaultProcessRunner.run(request);

export {
  DEFAULT_OUTPUT_BYTE_LIMIT,
  DEFAULT_PROCESS_ENV_ALLOWLIST,
  DEFAULT_TIMEOUT_MS,
  SPEC_KIT_CANDIDATES,
};
