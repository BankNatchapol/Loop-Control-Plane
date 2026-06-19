import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePrAgentVerdict } from "@/lib/engine/executors/pr-agent-review-runner";

describe("PR-Agent task review parsing", () => {
  it("requires AO fixes when PR-Agent returns key issues", () => {
    assert.equal(
      parsePrAgentVerdict([
        "review:",
        "  key_issues_to_review:",
        "    - relevant_file: |",
        "        src/app.ts",
        "  security_concerns: |",
        "    No",
      ].join("\n")),
      "needs changes",
    );
  });

  it("marks the task PR clean when issue list is empty", () => {
    assert.equal(
      parsePrAgentVerdict([
        "review:",
        "  key_issues_to_review: []",
        "  security_concerns: |",
        "    No",
      ].join("\n")),
      "approved",
    );
  });
});
