import { isExecutorBackend, type ExecutorBackend } from "@/lib/engine/loop-engine-types";

const isCiEnvironment = (): boolean =>
  process.env.CI === "true" ||
  process.env.CI === "1" ||
  process.env.NODE_ENV === "test";

/**
 * Global fallback backend when node and project defaults are unset.
 * Defaults to `stub` in CI/test; override locally with LOOPBOARD_DEFAULT_EXECUTOR_BACKEND.
 */
export const resolveGlobalDefaultExecutorBackend = (): ExecutorBackend => {
  const configured = process.env.LOOPBOARD_DEFAULT_EXECUTOR_BACKEND;
  if (typeof configured === "string" && isExecutorBackend(configured)) {
    return configured;
  }

  if (isCiEnvironment()) {
    return "stub";
  }

  return "stub";
};
