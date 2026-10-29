import { clearInterval, setInterval } from "node:timers";

/** Stop an interrupted run, but never signal after watcher cleanup. */
export function watchBackend(
  url,
  {
    intervalMs = 3000,
    timeoutMs = 2000,
    fetchImpl = fetch,
    onFailure = () => {
      console.error(
        `\n[e2e] the suite's backend (${url}) stopped answering. Its shared local services may have stopped. Stopping the run.\n`,
      );
      process.kill(process.pid, "SIGINT");
    },
  } = {},
) {
  let stopped = false;
  let misses = 0;
  /** @type {AbortController | null} */
  let active = null;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    active?.abort();
  };
  const timer = setInterval(async () => {
    if (stopped || active) return;
    const controller = new globalThis.AbortController();
    active = controller;
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(timeoutMs),
        ]),
      });
      if (!response.ok) throw new Error("Backend health check failed");
      if (!stopped) misses = 0;
    } catch {
      if (stopped || ++misses < 2) return;
      stop();
      onFailure();
    } finally {
      active = null;
    }
  }, intervalMs);
  timer.unref();
  return stop;
}
