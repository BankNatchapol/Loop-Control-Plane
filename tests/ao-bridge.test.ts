import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import {
  buildAoArgv,
  resolveAoCliInvocation,
  vendoredAoCliEntry,
} from "@/lib/ao-bridge/ao-cli-path";
import { resolveAoBridgeConfig } from "@/lib/ao-bridge/ao-config";
import { inferAoAttentionLevel, readIssueNumber } from "@/lib/ao-bridge/ao-session-mapper";
import { linkTaskToAoSession, buildIssueNumberIndex } from "@/lib/ao-bridge/ao-task-linker";
import type { AoDashboardSession } from "@/lib/ao-bridge/types";
import type { Task } from "@/lib/loopboard";

const baseTask = (overrides: Partial<Task> = {}): Task => ({
  id: "task-1",
  projectId: "project-1",
  featureId: "feature-1",
  title: "Test task",
  description: "desc",
  status: "ai-running",
  owner: "ai",
  mode: "execute",
  risk: "low",
  source: "manual",
  labels: [],
  acceptanceCriteria: [],
  branch: "main",
  worktree: "",
  github: { issueNumber: 42 },
  handoff: { available: false, contextPaths: [] },
  events: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

describe("ao bridge cli path", () => {
  it("prefers vendored ao entry when built unless path cli is forced", () => {
    const entry = vendoredAoCliEntry();
    const invocation = resolveAoCliInvocation();
    if (process.env.LOOPBOARD_AO_USE_PATH_CLI === "1") {
      assert.equal(invocation.source, "path");
      assert.equal(invocation.command, "ao");
      return;
    }

    if (entry) {
      assert.equal(invocation.source, "vendored");
      assert.equal(invocation.command, "node");
      assert.deepEqual(buildAoArgv(["status", "--json"]), [entry, "status", "--json"]);
    } else {
      assert.equal(invocation.source, "path");
      assert.equal(invocation.command, "ao");
    }
  });
});

describe("ao session mapper", () => {
  it("maps mergeable sessions to merge attention", () => {
    const level = inferAoAttentionLevel({
      id: "s1",
      projectId: "p1",
      status: "mergeable",
      activity: "ready",
      attentionLevel: "working",
      branch: null,
      issueId: "42",
      issueUrl: null,
      issueTitle: null,
      displayName: null,
      summary: null,
      createdAt: "",
      lastActivityAt: "",
      pr: null,
    });
    assert.equal(level, "merge");
  });

  it("reads issue numbers from session issue ids", () => {
    assert.equal(readIssueNumber({ issueId: "42" } as AoDashboardSession), 42);
  });
});

describe("ao task linker", () => {
  it("links tasks to sessions by issue number", () => {
    const sessions: AoDashboardSession[] = [
      {
        id: "session-42",
        projectId: "loop-control-plane",
        status: "working",
        activity: "active",
        attentionLevel: "working",
        branch: "feature/test",
        issueId: "42",
        issueUrl: null,
        issueTitle: "Issue",
        displayName: "Issue",
        summary: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActivityAt: "2026-01-01T00:00:00.000Z",
        pr: null,
      },
    ];

    const index = buildIssueNumberIndex(sessions);
    const runtime = linkTaskToAoSession(baseTask(), index);
    assert.equal(runtime?.sessionId, "session-42");
    assert.equal(runtime?.untrusted, true);
  });
});

describe("ao bridge config", () => {
  it("reads api base url from env", () => {
    const previous = process.env.LOOPBOARD_AO_API_BASE_URL;
    process.env.LOOPBOARD_AO_API_BASE_URL = "http://127.0.0.1:3999";
    try {
      assert.equal(resolveAoBridgeConfig().apiBaseUrl, "http://127.0.0.1:3999");
    } finally {
      if (previous === undefined) {
        delete process.env.LOOPBOARD_AO_API_BASE_URL;
      } else {
        process.env.LOOPBOARD_AO_API_BASE_URL = previous;
      }
    }
  });
});
