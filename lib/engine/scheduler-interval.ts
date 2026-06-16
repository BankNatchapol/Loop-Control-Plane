import { tickEngine } from "@/lib/api/engine-actions";
import { withLoopBoardRepository } from "@/lib/api/loopboard-http";

export const DEFAULT_ENGINE_TICK_INTERVAL_MS = 3_000;

let activeInterval: ReturnType<typeof setInterval> | null = null;

export const isSchedulerBackgroundTickActive = (): boolean =>
  activeInterval !== null;

export const stopSchedulerBackgroundTicks = (): void => {
  if (activeInterval !== null) {
    clearInterval(activeInterval);
    activeInterval = null;
  }
};

export const startSchedulerBackgroundTicks = (
  intervalMs: number = DEFAULT_ENGINE_TICK_INTERVAL_MS,
): void => {
  stopSchedulerBackgroundTicks();

  activeInterval = setInterval(() => {
    void (async () => {
      try {
        await withLoopBoardRepository(async (repository) => {
          const schedulerStatus = repository.getEngineSchedulerStatus();
          if (schedulerStatus.status !== "running") {
            stopSchedulerBackgroundTicks();
            return;
          }

          await tickEngine(repository, "automated");
        });
      } catch (error) {
        console.error("Engine scheduler background tick failed:", error);
      }
    })();
  }, intervalMs);
};
