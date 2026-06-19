import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkGitHubConnection,
  loopBoardGitHubLabels,
  redactGitHubToken,
  setupGitHubLabels,
} from "@/lib/github/github-connection";
import {
  normalizeGitHubRepository,
  parseGitHubRemoteUrl,
  parseGitHubRepository,
} from "@/lib/projects/project-repository-health";

describe("GitHub repository configuration", () => {
  it("normalizes owner/name repository configuration", () => {
    assert.equal(normalizeGitHubRepository(" bank-p/loop-control-plane "), "bank-p/loop-control-plane");
    assert.equal(normalizeGitHubRepository("/bank-p/loop-control-plane/"), "bank-p/loop-control-plane");
    assert.equal(normalizeGitHubRepository("bank-p"), "");
    assert.equal(normalizeGitHubRepository("https://github.com/bank-p/loop-control-plane"), "");
  });

  it("infers owner/name from GitHub remotes", () => {
    assert.equal(
      parseGitHubRepository("git@github.com:bank-p/loop-control-plane.git"),
      "bank-p/loop-control-plane",
    );
    assert.equal(
      parseGitHubRepository("https://github.com/bank-p/loop-control-plane.git"),
      "bank-p/loop-control-plane",
    );
    assert.equal(
      parseGitHubRemoteUrl("git@github.com:bank-p/loop-control-plane.git"),
      "https://github.com/bank-p/loop-control-plane",
    );
    assert.equal(parseGitHubRepository("https://example.com/bank-p/repo"), "");
  });

  it("reports disconnected and missing-token states without calling GitHub", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return new Response(null, { status: 200 });
    };

    assert.equal(
      (await checkGitHubConnection({ repository: "", token: "", fetcher })).status,
      "disconnected",
    );
    assert.equal(
      (await checkGitHubConnection({
        repository: "bank-p/loop-control-plane",
        token: "",
        fetcher,
      })).status,
      "token-missing",
    );
    assert.equal(calls, 0);
  });

  it("maps GitHub API responses to connection states", async () => {
    assert.equal(
      (await checkGitHubConnection({
        repository: "bank-p/loop-control-plane",
        token: "token",
        fetcher: async () => new Response(null, { status: 200 }),
      })).status,
      "connected",
    );
    assert.equal(
      (await checkGitHubConnection({
        repository: "bank-p/missing",
        token: "token",
        fetcher: async () => new Response(null, { status: 404 }),
      })).status,
      "repo-missing",
    );
    assert.equal(
      (await checkGitHubConnection({
        repository: "bank-p/loop-control-plane",
        token: "token",
        fetcher: async () => new Response(null, { status: 500, statusText: "Server Error" }),
      })).status,
      "api-error",
    );
  });

  it("redacts token text from thrown API errors", async () => {
    const result = await checkGitHubConnection({
      repository: "bank-p/loop-control-plane",
      token: "secret-token",
      fetcher: async () => {
        throw new Error("request failed for secret-token");
      },
    });

    assert.equal(result.status, "api-error");
    assert.equal(result.message.includes("secret-token"), false);
    assert.equal(redactGitHubToken("secret-token leaked", "secret-token"), "[redacted] leaked");
  });

  it("defines the required Loop Control Plane GitHub labels", () => {
    assert.deepEqual(
      loopBoardGitHubLabels.map((label) => label.name),
      [
        "loopboard",
        "ao-ready",
        "human-working",
        "human-review-needed",
        "risk-low",
        "risk-medium",
        "risk-high",
        "area-frontend",
        "area-backend",
        "area-infra",
        "area-test",
      ],
    );
  });

  it("does not call GitHub when label setup has no repository or token", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return new Response(null, { status: 200 });
    };

    assert.equal(
      (await setupGitHubLabels({ repository: "", token: "", fetcher })).status,
      "disconnected",
    );
    assert.equal(
      (await setupGitHubLabels({
        repository: "bank-p/loop-control-plane",
        token: "",
        fetcher,
      })).status,
      "token-missing",
    );
    assert.equal(calls, 0);
  });

  it("verifies existing labels and creates only missing labels", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });

      if (url.endsWith("/labels/loopboard")) {
        return new Response(null, { status: 200 });
      }

      if (url.endsWith("/labels/ao-ready")) {
        return new Response(null, { status: 404 });
      }

      if (method === "POST") {
        return new Response(null, { status: 201 });
      }

      return new Response(null, { status: 200 });
    };

    const result = await setupGitHubLabels({
      repository: "bank-p/loop-control-plane",
      token: "token",
      fetcher,
    });

    assert.equal(result.status, "ready");
    assert.equal(result.labels.find((label) => label.name === "loopboard")?.status, "exists");
    assert.equal(result.labels.find((label) => label.name === "ao-ready")?.status, "created");
    assert.equal(
      calls.some(
        (call) =>
          call.method === "POST" &&
          call.body &&
          typeof call.body === "object" &&
          "name" in call.body &&
          call.body.name === "ao-ready",
      ),
      true,
    );
    assert.equal(
      calls.some(
        (call) =>
          call.method === "PATCH" ||
          (call.method === "POST" &&
            call.body &&
            typeof call.body === "object" &&
            "name" in call.body &&
            call.body.name === "loopboard"),
      ),
      false,
    );
  });

  it("redacts token text from label setup errors", async () => {
    const result = await setupGitHubLabels({
      repository: "bank-p/loop-control-plane",
      token: "secret-token",
      fetcher: async () => {
        throw new Error("request failed for secret-token");
      },
    });

    assert.equal(result.status, "api-error");
    assert.equal(result.message.includes("secret-token"), false);
  });

  it("surfaces missing repositories during label creation", async () => {
    const result = await setupGitHubLabels({
      repository: "bank-p/missing",
      token: "token",
      fetcher: async (_input, init) =>
        new Response(null, { status: init?.method === "POST" ? 404 : 404 }),
    });

    assert.equal(result.status, "repo-missing");
    assert.equal(result.labels[0]?.status, "error");
  });
});
