import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BACKEND_AVAILABILITY_CACHE_TTL_MS,
  buildBackendAvailabilityReport,
  formatBackendAvailabilityChipLabel,
  getBackendAvailabilityReport,
  resetBackendAvailabilityCache,
} from "@/lib/engine/backend-availability-service";
import { seedProject } from "@/lib/loopboard";

describe("backend availability service", () => {
  it("formats short availability chip labels", () => {
    assert.equal(
      formatBackendAvailabilityChipLabel("cursor", true, "cursor agent available"),
      "cursor: installed",
    );
    assert.equal(
      formatBackendAvailabilityChipLabel(
        "cursor",
        false,
        "Cursor CLI not found. Install Cursor and ensure `cursor agent --version` succeeds.",
      ),
      "cursor: not installed",
    );
    assert.equal(
      formatBackendAvailabilityChipLabel(
        "agent-orchestrator",
        false,
        "Agent Orchestrator is disabled in project settings.",
      ),
      "agent-orchestrator: disabled",
    );
    assert.equal(
      formatBackendAvailabilityChipLabel(
        "agent-orchestrator",
        false,
        "Agent Orchestrator config path does not exist: missing.yaml",
      ),
      "agent-orchestrator: config missing",
    );
    assert.equal(formatBackendAvailabilityChipLabel("stub", true, ""), "stub: available");
  });

  it("returns all executor backends in a report", () => {
    const report = buildBackendAvailabilityReport(seedProject);

    assert.equal(report.cacheTtlMs, BACKEND_AVAILABILITY_CACHE_TTL_MS);
    assert.equal(report.backends.length, 5);
    assert.ok(report.backends.some((entry) => entry.backend === "stub" && entry.available));
  });

  it("caches availability checks for 60 seconds", () => {
    resetBackendAvailabilityCache();

    const first = getBackendAvailabilityReport(seedProject, 1_000);
    const second = getBackendAvailabilityReport(seedProject, 30_000);

    assert.equal(first.checkedAt, second.checkedAt);

    const third = getBackendAvailabilityReport(
      seedProject,
      1_000 + BACKEND_AVAILABILITY_CACHE_TTL_MS + 1,
    );

    assert.notEqual(first.checkedAt, third.checkedAt);
  });
});
