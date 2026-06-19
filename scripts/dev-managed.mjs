import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const aoRoot = resolve(root, "vendor", "agent-orchestrator");
const aoEntry = resolve(aoRoot, "packages", "cli", "dist", "index.js");
const shutdownTimeoutMs = 15_000;
const managedPorts = [3000, 3100, 14801, 31101];
const controlPort = Number.parseInt(process.env.LOOPBOARD_CONTROL_PORT ?? "31999", 10);

const children = new Map();
const managedPids = new Set();
const managedProcessGroups = new Set();
let shuttingDown = false;
let requestedExitCode = 0;

const localAoArgs = (args) => [aoEntry, ...args];

const commandExists = (command, args = ["--version"]) =>
  spawnSync(command, args, { stdio: "ignore", env: process.env }).status === 0;

const assertPrerequisites = () => {
  if (!commandExists("node")) {
    throw new Error("Node.js is required.");
  }
  if (!commandExists("tmux", ["-V"])) {
    throw new Error("tmux is required by the managed AO runtime.");
  }
  if (!existsSync(aoEntry)) {
    throw new Error("Local AO is not built. Run `npm run ao:setup` first.");
  }
};

const spawnService = (name, command, args, options = {}) => {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: "inherit",
    // Keep terminal signals on the supervisor. The supervisor owns shutdown
    // and explicitly signals each service group in a deterministic order.
    detached: process.platform !== "win32",
  });

  children.set(name, child);
  if (child.pid) {
    managedPids.add(child.pid);
    if (process.platform !== "win32") managedProcessGroups.add(child.pid);
  }
  child.once("error", (error) => {
    console.error(`[managed] ${name} failed to start:`, error);
    requestedExitCode = 1;
    void shutdown(`${name} start failure`);
  });
  child.once("exit", (code, signal) => {
    children.delete(name);
    if (!shuttingDown) {
      requestedExitCode = code ?? (signal ? 1 : 0);
      void shutdown(`${name} exited`);
    }
  });

  return child;
};

const terminateChild = (child, signal) => {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  for (const pid of processTree(child.pid)) {
    managedPids.add(pid);
  }
  terminateProcessGroup(child.pid, signal);
};

const processTree = (rootPid) => {
  if (process.platform === "win32") return [rootPid];

  const output = spawnSync("ps", ["-axo", "pid=,ppid="], {
    encoding: "utf8",
    env: process.env,
  }).stdout;
  if (typeof output !== "string") return [rootPid];

  const childrenByParent = new Map();
  for (const line of output.trim().split("\n")) {
    const [pidText, parentText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const parentPid = Number(parentText);
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) continue;
    const descendants = childrenByParent.get(parentPid) ?? [];
    descendants.push(pid);
    childrenByParent.set(parentPid, descendants);
  }

  const result = [];
  const visit = (pid) => {
    for (const childPid of childrenByParent.get(pid) ?? []) visit(childPid);
    result.push(pid);
  };
  visit(rootPid);
  return result;
};

const terminateProcessTree = (rootPid, signal) => {
  if (!rootPid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(rootPid), "/T", signal === "SIGKILL" ? "/F" : ""].filter(Boolean), {
      stdio: "ignore",
      env: process.env,
    });
    return;
  }

  for (const pid of processTree(rootPid)) {
    if (pid === process.pid) continue;
    try {
      process.kill(pid, signal);
    } catch {
      // The process may have exited between the snapshot and signal.
    }
  }
};

const terminateProcessGroup = (groupId, signal) => {
  if (!groupId) return;
  if (process.platform === "win32") {
    terminateProcessTree(groupId, signal);
    return;
  }
  try {
    process.kill(-groupId, signal);
  } catch {
    // The group may already be gone.
  }
};

const discoverAoWebPids = () => {
  if (process.platform === "win32") return [];
  const output = spawnSync("ps", ["-axo", "pid=,comm="], {
    encoding: "utf8",
    env: process.env,
  }).stdout;
  if (typeof output !== "string") return [];

  const result = [];
  for (const line of output.trim().split("\n")) {
    const [pidText, ...commandParts] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || !commandParts.join(" ").includes("node")) continue;
    const cwdOutput = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "ignore"],
    }).stdout;
    if (typeof cwdOutput !== "string") continue;
    const cwd = cwdOutput
      .split("\n")
      .find((entry) => entry.startsWith("n"))
      ?.slice(1);
    if (cwd?.startsWith(resolve(aoRoot, "packages", "web"))) result.push(pid);
  }
  return result;
};

const portIsOpen = (port) =>
  new Promise((resolveOpen) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolveOpen(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolveOpen(false);
    });
    socket.setTimeout(500, () => {
      socket.destroy();
      resolveOpen(false);
    });
  });

const waitForPortsClosed = async (ports, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const states = await Promise.all(ports.map(portIsOpen));
    if (states.every((open) => !open)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return false;
};

const terminateManagedPids = (signal) => {
  for (const groupId of managedProcessGroups) {
    terminateProcessGroup(groupId, signal);
  }
  for (const pid of discoverAoWebPids()) {
    managedPids.add(pid);
  }
  for (const pid of managedPids) {
    terminateProcessTree(pid, signal);
  }
};

const waitForChildren = async (timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (children.size > 0 && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
};

const waitForPort = async (port, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await portIsOpen(port);
    if (ready) return;
    if (shuttingDown) {
      throw new Error("Managed startup was interrupted.");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`Timed out waiting for port ${port}.`);
};

const openBrowser = (url) => {
  if (!process.stdout.isTTY) return;
  const [command, args] =
    process.platform === "win32"
      ? ["cmd.exe", ["/c", "start", "", url]]
      : [process.platform === "linux" ? "xdg-open" : "open", [url]];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    console.warn(`[managed] Could not open ${url} in a browser.`);
  });
  child.unref();
};

const runAoStop = () =>
  spawnSync("node", localAoArgs(["stop", "--all", "--yes"]), {
    cwd: root,
    env: { ...process.env, AO_CALLER_TYPE: "agent" },
    stdio: "inherit",
    timeout: shutdownTimeoutMs,
  });

const forceSweep = () => {
  for (const pid of discoverAoWebPids()) {
    managedPids.add(pid);
  }

  const sessionNames = spawnSync(
    "tmux",
    ["list-panes", "-a", "-F", "#{session_name}\t#{pane_current_path}"],
    { encoding: "utf8", env: process.env },
  ).stdout;

  if (typeof sessionNames === "string") {
    const names = new Set(
      sessionNames
        .trim()
        .split("\n")
        .map((line) => line.split("\t"))
        .filter(([, cwd]) => cwd?.includes("/.agent-orchestrator/"))
        .map(([name]) => name)
        .filter(Boolean),
    );
    for (const name of names) {
      spawnSync("tmux", ["kill-session", "-t", name], { stdio: "ignore", env: process.env });
    }
  }

  if (process.platform !== "win32") {
    for (const pattern of [
      "@aoagents/ao",
      "dist-server/start-all.js",
      "dist-server/direct-terminal-ws.js",
    ]) {
      spawnSync("pkill", ["-TERM", "-f", pattern], { stdio: "ignore", env: process.env });
    }
  }
};

const startControlServer = () => {
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/shutdown") {
      response.writeHead(202, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      void shutdown("ui quit");
      return;
    }

    response.writeHead(404);
    response.end();
  });

  server.listen(controlPort, "127.0.0.1", () => {
    console.log(`[managed] Quit control API: http://127.0.0.1:${controlPort}/shutdown`);
  });

  return server;
};

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[managed] Shutting down: ${reason}`);

  for (const child of [...children.values()]) {
    terminateChild(child, "SIGTERM");
  }
  await waitForChildren(8_000);

  if (children.size > 0) {
    for (const child of [...children.values()]) {
      terminateChild(child, "SIGKILL");
    }
    await waitForChildren(2_000);
  }

  const stopResult = runAoStop();
  if (stopResult.status !== 0) {
    console.warn("[managed] AO graceful cleanup was incomplete; running forced sweep.");
  }
  forceSweep();

  // Dashboard descendants can close their listeners before fully exiting.
  // Kill every PID captured from the managed trees even when all ports are
  // already closed, so no idle next-server survives as an orphan.
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  terminateManagedPids("SIGKILL");

  let portsClosed = await waitForPortsClosed(managedPorts, 5_000);
  if (!portsClosed) {
    console.warn("[managed] Managed ports are still open; force-killing known process trees.");
    terminateManagedPids("SIGKILL");
    forceSweep();
    portsClosed = await waitForPortsClosed(managedPorts, 3_000);
  }

  if (!portsClosed) {
    console.error("[managed] Shutdown incomplete: one or more managed ports remain open.");
    requestedExitCode = 1;
  } else {
    console.log("[managed] Shutdown complete.");
  }

  process.exit(requestedExitCode);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    requestedExitCode = signal === "SIGINT" ? 130 : 0;
    void shutdown(signal);
  });
}

process.once("uncaughtException", (error) => {
  console.error(error);
  requestedExitCode = 1;
  void shutdown("uncaught exception");
});

process.once("unhandledRejection", (error) => {
  console.error(error);
  requestedExitCode = 1;
  void shutdown("unhandled rejection");
});

process.once("exit", () => {
  if (!shuttingDown) {
    terminateManagedPids("SIGTERM");
    forceSweep();
  }
});

assertPrerequisites();
startControlServer();

const startupStop = runAoStop();
if (startupStop.status !== 0) {
  console.warn("[managed] Pre-start AO cleanup was incomplete; sweeping stale processes.");
  forceSweep();
}
await waitForPortsClosed(managedPorts, 5_000);

spawnService(
  "agent-orchestrator",
  "node",
  localAoArgs(["start", root, "--reap-orphans", "--no-restore"]),
  {
    env: {
      AO_CALLER_TYPE: "agent",
      AO_LOOPBOARD_HEADLESS: "1",
      LOOPBOARD_AO_HEADLESS: "1",
    },
  },
);
await waitForPort(3000, 30_000);
spawnService("ao-mux-proxy", "node", [resolve(root, "scripts", "ao-mux-proxy.mjs")]);
spawnService(
  "loop-control-plane",
  "node",
  [resolve(root, "node_modules", "next", "dist", "bin", "next"), "dev", "--port", "3100"],
  {
    env: {
      LOOPBOARD_MANAGED: "1",
      NEXT_PUBLIC_LOOPBOARD_MANAGED: "1",
      LOOPBOARD_CONTROL_PORT: String(controlPort),
    },
  },
);
await waitForPort(3100, 60_000);
openBrowser("http://localhost:3100");

console.log("[managed] Loop Control Plane: http://localhost:3100");
console.log("[managed] AO API (internal): http://127.0.0.1:3000");
console.log("[managed] AO mux proxy: ws://127.0.0.1:31101/mux");
