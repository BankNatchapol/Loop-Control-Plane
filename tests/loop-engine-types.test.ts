import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defaultExecutorRegistry,
  defaultStubExecutor,
  ExecutorRegistry,
  explainExecutorResolution,
  parseExecutorConfig,
  resolveExecutorConfigForJob,
} from "@/lib/engine/executor-registry";
import {
  defaultExecutorConfig,
  EXECUTOR_CONFIG_KEY,
  readExecutorConfig,
  resolveExecutorTarget,
  validateExecutorConfig,
  withExecutorConfig,
  type EngineJob,
} from "@/lib/engine/loop-engine-types";

const sampleJob = (
  overrides: Partial<EngineJob> = {},
): EngineJob => ({
  id: "job-demo-1",
  kind: "demo-ping",
  status: "queued",
  backend: "stub",
  payload: {},
  executionLogs: [],
  attempt: 1,
  maxAttempts: 3,
  queuedAt: "2026-06-16T12:00:00.000Z",
  createdAt: "2026-06-16T12:00:00.000Z",
  updatedAt: "2026-06-16T12:00:00.000Z",
  ...overrides,
});

describe("Loop engine types", () => {
  it("validates executor config and rejects unknown backends", () => {
    const valid = validateExecutorConfig({
      backend: "stub",
      command: "echo ping",
      args: ["test"],
      cwd: "/tmp/project",
      timeoutMs: 5000,
      envAllowlist: ["PATH"],
    });

    assert.equal(valid.ok, true);
    if (valid.ok) {
      assert.deepEqual(valid.config, {
        backend: "stub",
        command: "echo ping",
        args: ["test"],
        workingDirectory: "/tmp/project",
        cwd: "/tmp/project",
        timeoutMs: 5000,
        envAllowlist: ["PATH"],
      });
    }

    const invalid = validateExecutorConfig({ backend: "unknown-backend" });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) {
      assert.equal(invalid.code, "executor_config_invalid");
      assert.match(invalid.issues[0]?.message ?? "", /backend/i);
    }
  });

  it("reads and writes executor config from workflow node config JSON", () => {
    const nodeConfig = withExecutorConfig(
      { optional: true },
      defaultExecutorConfig("stub"),
    );

    assert.ok(nodeConfig[EXECUTOR_CONFIG_KEY]);
    assert.deepEqual(readExecutorConfig(nodeConfig), { backend: "stub" });
  });

  it("resolves executor targets with explainable disabled-backend errors", () => {
    const disabled = resolveExecutorTarget("cursor", "demo-ping");
    assert.equal(disabled.ok, false);
    if (!disabled.ok) {
      assert.equal(disabled.code, "executor_backend_disabled");
      assert.match(disabled.reasons.join(" "), /not enabled/i);
    }

    const unknown = resolveExecutorTarget("made-up", "demo-ping");
    assert.equal(unknown.ok, false);
    if (!unknown.ok) {
      assert.equal(unknown.code, "executor_backend_unknown");
    }

    const ready = resolveExecutorTarget("stub", "task-run");
    assert.deepEqual(ready, { ok: true, backend: "stub", jobKind: "task-run" });
  });
});

describe("Executor registry", () => {
  it("registers the stub executor and resolves supported job kinds", () => {
    const resolution = explainExecutorResolution("stub", "demo-ping");
    assert.equal(resolution.ok, true);

    const unsupported = defaultExecutorRegistry.resolve("stub", "not-a-kind");
    assert.equal(unsupported.ok, false);
    if (!unsupported.ok) {
      assert.equal(unsupported.code, "engine_job_kind_unknown");
    }
  });

  it("returns disabled errors for unregistered real backends", () => {
    const emptyRegistry = new ExecutorRegistry([]);
    const resolution = emptyRegistry.resolve("stub", "demo-ping");

    assert.equal(resolution.ok, false);
    if (!resolution.ok) {
      assert.equal(resolution.code, "executor_backend_disabled");
    }
  });

  it("executes stub jobs deterministically with redacted summaries", async () => {
    const result = await defaultStubExecutor.execute({
      job: sampleJob(),
      config: {
        backend: "stub",
        command: "token=super-secret ping",
      },
    });

    assert.equal(result.success, true);
    assert.match(result.stdoutSummary ?? "", /completed deterministically|stub stdout/i);
    assert.doesNotMatch(result.stdoutSummary ?? "", /super-secret/);
    assert.equal(result.result?.completedDeterministically, true);
    assert.ok(result.logs.length >= 2);
  });

  it("parses payload executor config when present", () => {
    const config = resolveExecutorConfigForJob(
      sampleJob({
        payload: {
          executor: {
            backend: "stub",
            command: "demo",
          },
        },
      }),
    );

    assert.deepEqual(config, { backend: "stub", command: "demo" });
  });

  it("falls back to parseExecutorConfig helper errors", () => {
    const parsed = parseExecutorConfig({ backend: "codex", timeoutMs: -1 });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.equal(parsed.code, "executor_config_invalid");
    }
  });
});
