// Fire-and-forget runner for long agent work. Failures mark the run failed and surface an error step.
import { store } from "../../src/lib/store";
import { emit } from "../../src/lib/trace";

export function runInBackground(runId: string, work: () => Promise<unknown>): void {
  Promise.resolve()
    .then(work)
    .catch((err: unknown) => {
      const text = err instanceof Error ? err.message : String(err);
      console.error(`[run ${runId}] failed:`, err);
      try {
        store.patchRun(runId, { status: "failed" });
        emit(runId, "error", { text }, "run");
      } catch (e) {
        console.error(`[run ${runId}] could not record failure:`, e);
      }
    });
}
