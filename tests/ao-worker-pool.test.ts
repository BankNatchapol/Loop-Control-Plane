import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runAoWorkerPool } from "@/lib/engine/backends/ao-worker-pool";
import type { AoSessionJson } from "@/lib/engine/backends/ao-session-status";

describe("ao worker pool", () => {
  it("reuses completed checkpoint items without spawning duplicate workers", async () => {
    let spawns = 0;
    const result = await runAoWorkerPool({
      issueNumbers: [11, 12],
      initialItems: [
        {
          issueNumber: 11,
          state: "completed",
          prUrl: "https://github.com/acme/repo/pull/11",
        },
      ],
      maxConcurrentWorkers: 1,
      timeoutMs: 1_000,
      pollIntervalMs: 0,
      sleep: async () => {},
      spawnOne: async (issueNumber) => {
        spawns += 1;
        return { sessionId: `session-${issueNumber}` };
      },
      pollSessions: async () =>
        spawns === 0
          ? []
          : [
              {
                id: "session-12",
                issueId: 12,
                status: "done",
                pr: { url: "https://github.com/acme/repo/pull/12" },
              },
            ],
    });

    assert.equal(spawns, 1);
    assert.equal(result.records.find((record) => record.issueNumber === 11)?.prUrl,
      "https://github.com/acme/repo/pull/11");
  });

  it("never exceeds max concurrent running sessions", async () => {
    let maxActive = 0;
    let pollCount = 0;
    const issueNumbers = [1, 2, 3, 4, 5];

    const poolResult = await runAoWorkerPool({
      issueNumbers,
      maxConcurrentWorkers: 2,
      timeoutMs: 5_000,
      pollIntervalMs: 5,
      sleep: async () => undefined,
      spawnOne: async (issueNumber) => ({ sessionId: `session-${issueNumber}` }),
      pollSessions: async () => {
        pollCount += 1;
        const sessions: AoSessionJson[] = issueNumbers.map((issueNumber) => ({
          id: `session-${issueNumber}`,
          issueId: String(issueNumber),
          status: issueNumber <= pollCount ? "done" : "working",
        }));
        return sessions;
      },
      onSnapshot: (snapshot) => {
        const active = snapshot.items.filter(
          (item) => item.state === "running" || item.state === "spawning",
        ).length;
        maxActive = Math.max(maxActive, active);
      },
    });

    assert.ok(maxActive <= 2, `expected <= 2 active sessions, saw ${maxActive}`);
    assert.equal(poolResult.timedOut, false);
    assert.equal(
      poolResult.records.filter((record) => record.status === "done").length,
      issueNumbers.length,
    );
  });

  it("calls onSnapshot during the run", async () => {
    let snapshotCount = 0;

    await runAoWorkerPool({
      issueNumbers: [42],
      maxConcurrentWorkers: 1,
      timeoutMs: 100,
      pollIntervalMs: 5,
      sleep: async () => undefined,
      spawnOne: async () => ({ sessionId: "session-42" }),
      pollSessions: async () => [
        { id: "session-42", issueId: "42", status: "done" },
      ],
      onSnapshot: () => {
        snapshotCount += 1;
      },
    });

    assert.ok(snapshotCount >= 1);
  });

  it("holds a terminal AO session while its task PR review loop is pending", async () => {
    let observations = 0;

    const poolResult = await runAoWorkerPool({
      issueNumbers: [51],
      maxConcurrentWorkers: 1,
      timeoutMs: 1_000,
      pollIntervalMs: 5,
      sleep: async () => undefined,
      spawnOne: async () => ({ sessionId: "session-51" }),
      pollSessions: async () => [{
        id: "session-51",
        issueId: "51",
        status: "done",
        pr: { url: "https://github.com/org/repo/pull/51" },
      }],
      onSessionObserved: async () => {
        observations += 1;
        return observations === 1 ? "hold" : "continue";
      },
    });

    assert.ok(observations >= 2);
    assert.equal(poolResult.records[0]?.status, "done");
  });
});
