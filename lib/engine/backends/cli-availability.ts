import { spawnSync } from "node:child_process";

import type { ExecutorBackend } from "@/lib/engine/loop-engine-types";

import type { BackendAvailabilityResult } from "@/lib/engine/backends/backend-adapter";

export type CliProbe = {
  backend: ExecutorBackend;
  command: string;
  args: readonly string[];
  unavailableMessage: string;
};

const VERSION_PROBE_TIMEOUT_MS = 2_000;

export const CLI_PROBES: readonly CliProbe[] = [
  {
    backend: "cursor",
    command: "cursor",
    args: ["agent", "--version"],
    unavailableMessage:
      "Cursor CLI not found. Install Cursor and ensure `cursor agent --version` succeeds.",
  },
  {
    backend: "claude-code",
    command: "claude",
    args: ["--version"],
    unavailableMessage:
      "Claude Code CLI not found. Install Claude Code and ensure `claude --version` succeeds.",
  },
  {
    backend: "codex",
    command: "codex",
    args: ["--version"],
    unavailableMessage:
      "Codex CLI not found. Install Codex and ensure `codex --version` succeeds.",
  },
  {
    backend: "agent-orchestrator",
    command: "ao",
    args: ["--version"],
    unavailableMessage:
      "Agent Orchestrator CLI not found. Install with `npm install -g @aoagents/ao`.",
  },
] as const;

const summarizeProbeOutput = (stdout: string, stderr: string): string | undefined => {
  const combined = `${stdout}\n${stderr}`.trim();
  if (combined.length === 0) {
    return undefined;
  }

  const firstLine = combined.split(/\r?\n/u).find((line) => line.trim().length > 0);
  return firstLine?.trim();
};

type ProbeEnv = Record<string, string | undefined>;

export const probeCliAvailability = (
  probe: CliProbe,
  env: ProbeEnv = process.env,
): BackendAvailabilityResult => {
  const result = spawnSync(probe.command, [...probe.args], {
    encoding: "utf8",
    env: env as NodeJS.ProcessEnv,
    timeout: VERSION_PROBE_TIMEOUT_MS,
  });

  if (result.error || result.status !== 0) {
    return {
      backend: probe.backend,
      available: false,
      message: probe.unavailableMessage,
    };
  }

  const version = summarizeProbeOutput(result.stdout ?? "", result.stderr ?? "");

  return {
    backend: probe.backend,
    available: true,
    message: version
      ? `${probe.command} available (${version}).`
      : `${probe.command} available.`,
    ...(version ? { version } : {}),
  };
};

export const probeCliAvailabilityForBackend = (
  backend: Exclude<ExecutorBackend, "stub">,
  env: ProbeEnv = process.env,
): BackendAvailabilityResult => {
  const probe = CLI_PROBES.find((entry) => entry.backend === backend);
  if (!probe) {
    return {
      backend,
      available: false,
      message: `No CLI probe registered for backend "${backend}".`,
    };
  }

  return probeCliAvailability(probe, env);
};

export const probeAllExternalCliAvailability = (
  env: ProbeEnv = process.env,
): BackendAvailabilityResult[] => CLI_PROBES.map((probe) => probeCliAvailability(probe, env));
