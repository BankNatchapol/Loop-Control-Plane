import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deriveEnginePanelEmptyStates,
  describeEngineMetricsEmptyHint,
  describeQueueDepthHint,
} from "@/lib/engine/engine-panel-empty-states";

describe("engine-panel-empty-states", () => {
  it("shows engine-never-run when scheduler has not ticked", () => {
    const states = deriveEnginePanelEmptyStates({
      tickCount: 0,
      lastTickAt: null,
      queuedCount: 0,
      runningCount: 0,
      backends: [{ backend: "stub", label: "stub: available", available: true, message: "" }],
    });

    assert.equal(states.some((state) => state.kind === "engine-never-run"), true);
    assert.equal(states.some((state) => state.kind === "no-jobs-queued"), false);
  });

  it("shows no-jobs-queued after the scheduler has ticked", () => {
    const states = deriveEnginePanelEmptyStates({
      tickCount: 3,
      lastTickAt: "2026-06-16T12:00:00.000Z",
      queuedCount: 0,
      runningCount: 0,
      backends: [],
    });

    assert.equal(states.some((state) => state.kind === "no-jobs-queued"), true);
    assert.equal(states.some((state) => state.kind === "engine-never-run"), false);
  });

  it("shows backends-unavailable when all cli backends are down", () => {
    const states = deriveEnginePanelEmptyStates({
      tickCount: 1,
      lastTickAt: "2026-06-16T12:00:00.000Z",
      queuedCount: 0,
      runningCount: 0,
      backends: [
        { backend: "stub", label: "stub: available", available: true, message: "" },
        {
          backend: "cursor",
          label: "cursor: not installed",
          available: false,
          message: "cursor CLI not found",
        },
        {
          backend: "claude-code",
          label: "claude-code: not installed",
          available: false,
          message: "claude-code CLI not found",
        },
        {
          backend: "codex",
          label: "codex: not installed",
          available: false,
          message: "codex CLI not found",
        },
        {
          backend: "agent-orchestrator",
          label: "agent-orchestrator: not installed",
          available: false,
          message: "agent-orchestrator CLI not found",
        },
      ],
    });

    assert.equal(states.some((state) => state.kind === "backends-unavailable"), true);
  });

  it("shows ao-not-configured when AO is disabled in project settings", () => {
    const states = deriveEnginePanelEmptyStates({
      tickCount: 1,
      lastTickAt: "2026-06-16T12:00:00.000Z",
      queuedCount: 0,
      runningCount: 0,
      backends: [
        {
          backend: "agent-orchestrator",
          label: "agent-orchestrator: disabled",
          available: false,
          message: "Agent Orchestrator is disabled in project settings.",
        },
      ],
    });

    assert.equal(states.some((state) => state.kind === "ao-not-configured"), true);
  });

  it("describes queue and metrics empty hints", () => {
    assert.equal(
      describeQueueDepthHint({
        tickCount: 0,
        lastTickAt: null,
        queuedCount: 0,
        runningCount: 0,
      }),
      "Scheduler idle · no ticks yet",
    );

    assert.equal(
      describeEngineMetricsEmptyHint({
        windowHours: 24,
        since: "2026-06-16T00:00:00.000Z",
        queued: 0,
        running: 0,
        completed: 0,
        failed: 0,
        averageDurationMs: null,
        failureRate: null,
      }),
      "No engine activity recorded in the last 24 hours.",
    );
  });
});
