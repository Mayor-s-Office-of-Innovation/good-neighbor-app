import { getCaptureGuidance } from "./api.js";
import { startingGuidance } from "../domain/capture-guidance.js";

/**
 * One bounded, strongly consistent guidance read; caller cancels on navigation.
 * @param {{id: string, startedAt: string, siteId?: string}} check
 * @param {AbortSignal} [signal]
 * @returns {Promise<{titleKey: string}>}
 */
export async function loadStartingGuidance(check, signal) {
  const { counts } = await getCaptureGuidance({
    startedAt: check.startedAt,
    checkId: check.id,
    siteId: check.siteId,
    signal,
  });
  if (
    !Array.isArray(counts) ||
    counts.length !== 5 ||
    counts.some((count) => !Number.isInteger(count) || count < 0)
  ) {
    throw new Error("Invalid capture guidance counts");
  }
  return startingGuidance(counts);
}
