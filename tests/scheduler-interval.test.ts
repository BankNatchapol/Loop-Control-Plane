import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  DEFAULT_ENGINE_TICK_INTERVAL_MS,
  isSchedulerBackgroundTickActive,
  startSchedulerBackgroundTicks,
  stopSchedulerBackgroundTicks,
} from "@/lib/engine/scheduler-interval";

describe("scheduler background ticks", () => {
  afterEach(() => {
    stopSchedulerBackgroundTicks();
  });

  it("tracks active interval ownership", () => {
    assert.equal(isSchedulerBackgroundTickActive(), false);

    startSchedulerBackgroundTicks(60_000);
    assert.equal(isSchedulerBackgroundTickActive(), true);

    stopSchedulerBackgroundTicks();
    assert.equal(isSchedulerBackgroundTickActive(), false);
  });

  it("clears intervals idempotently on repeated stop calls", () => {
    startSchedulerBackgroundTicks(60_000);
    stopSchedulerBackgroundTicks();
    stopSchedulerBackgroundTicks();

    assert.equal(isSchedulerBackgroundTickActive(), false);
  });

  it("replaces an existing interval when started again", () => {
    startSchedulerBackgroundTicks(60_000);
    startSchedulerBackgroundTicks(60_000);

    assert.equal(isSchedulerBackgroundTickActive(), true);

    stopSchedulerBackgroundTicks();
    assert.equal(isSchedulerBackgroundTickActive(), false);
  });

  it("uses the default tick interval constant", () => {
    assert.equal(DEFAULT_ENGINE_TICK_INTERVAL_MS, 3_000);
  });
});
