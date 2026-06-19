import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const aoRoot = resolve(root, "vendor", "agent-orchestrator");

const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

run("git", ["submodule", "update", "--init", "--recursive"]);
run("corepack", ["pnpm", "install", "--frozen-lockfile"], aoRoot);
run("corepack", ["pnpm", "build"], aoRoot);

console.log("Managed Agent Orchestrator is installed and built.");
