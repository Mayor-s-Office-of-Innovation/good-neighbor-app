import { trackEvent } from "./analytics.js";

/**
 * Observe a stage without changing its timeout, retries, result, or error.
 * Only explicit metadata leaves the device: never errors, URLs, or photo content.
 * @template T
 * @param {"presign" | "put" | "register" | "analyze" | "evaluate"} stage
 * @param {{check_id: string, attempt_id: string, artifact_id?: string, photo_bytes?: number}} context
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function observePhotoStage(stage, context, work) {
  const started = Date.now();
  const emit = (/** @type {string} */ outcome, status = 0) => {
    // Telemetry must never interfere with the capture pipeline.
    try {
      void trackEvent("photo_pipeline", {
        ...context,
        stage,
        outcome,
        elapsed_ms: Math.max(0, Date.now() - started),
        http_status: status,
        online: typeof navigator === "undefined" ? false : navigator.onLine,
        visibility:
          typeof document === "undefined"
            ? "unknown"
            : document.visibilityState,
      }).catch(() => {});
    } catch {
      /* unavailable browser APIs */
    }
  };
  emit("started");
  // One warning per stage, not a continuous stream during a stalled upload.
  const timer = setTimeout(() => emit("slow"), 30_000);
  try {
    const result = await work();
    const failed =
      stage === "analyze" &&
      result &&
      typeof result === "object" &&
      "status" in result &&
      result.status === "failed";
    emit(failed ? "backend_failed" : "completed");
    return result;
  } catch (error) {
    const err =
      /** @type {{status?: number, name?: string, body?: {code?: string}}} */ (
        error || {}
      );
    emit(
      err.body?.code === "analyses_pending"
        ? "timeout"
        : err.name === "AbortError"
          ? "cancelled"
          : "failed",
      Number.isInteger(err.status) &&
        Number(err.status) >= 0 &&
        Number(err.status) <= 599
        ? err.status
        : 0,
    );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
