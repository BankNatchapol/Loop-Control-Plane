import { existsSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(process.cwd());
const VENDORED_AO_ENTRY = resolve(
  REPO_ROOT,
  "vendor",
  "agent-orchestrator",
  "packages",
  "cli",
  "dist",
  "index.js",
);

export type AoCliInvocation = {
  command: string;
  prefixArgs: readonly string[];
  source: "vendored" | "path";
};

export const vendoredAoCliEntry = (): string | undefined =>
  existsSync(VENDORED_AO_ENTRY) ? VENDORED_AO_ENTRY : undefined;

export const resolveAoCliInvocation = (): AoCliInvocation => {
  if (process.env.LOOPBOARD_AO_USE_PATH_CLI === "1") {
    return {
      command: "ao",
      prefixArgs: [],
      source: "path",
    };
  }

  const entry = vendoredAoCliEntry();
  if (entry) {
    return {
      command: "node",
      prefixArgs: [entry],
      source: "vendored",
    };
  }

  return {
    command: "ao",
    prefixArgs: [],
    source: "path",
  };
};

export const buildAoArgv = (args: string[]): string[] => {
  const invocation = resolveAoCliInvocation();
  return [...invocation.prefixArgs, ...args];
};
