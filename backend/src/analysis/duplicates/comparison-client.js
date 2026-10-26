import { comparisonWait } from "./request-pacing.js";

/**
 * @param {{baseUrl:string,apiKey:string,fetchImpl?:typeof fetch,pace?:(signal:globalThis.AbortSignal,start:()=>Promise<Response>)=>Promise<{pending:Promise<Response>}>,deadlineMs?:number,attemptTimeoutMs?:number}} options
 * @returns {import("./image-matcher.js").Compare}
 */
export function createComparisonClient({
  baseUrl,
  apiKey,
  fetchImpl = fetch,
  pace = async (_signal, start) => ({ pending: start() }),
  deadlineMs = 60000,
  attemptTimeoutMs = 27000,
}) {
  const endpoint = new URL(
    "v1/image-comparisons",
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  );
  if (
    endpoint.protocol !== "https:" &&
    !(
      endpoint.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(endpoint.hostname)
    )
  )
    throw new Error("Comparison endpoint must use TLS or loopback");
  if (
    !Number.isFinite(deadlineMs) ||
    deadlineMs <= 0 ||
    !Number.isFinite(attemptTimeoutMs) ||
    attemptTimeoutMs <= 0
  )
    throw new Error("Invalid comparison deadline");
  return async (request) => {
    const deadline = globalThis.AbortSignal.timeout(deadlineMs);
    const body = JSON.stringify(request);
    for (let attempt = 0; attempt < 4; attempt++) {
      deadline.throwIfAborted();
      // Create each HTTP timeout at actual start, after any pacing wait.
      let signal = deadline;
      const { pending } = await pace(deadline, () => {
        deadline.throwIfAborted();
        signal = globalThis.AbortSignal.any([
          deadline,
          globalThis.AbortSignal.timeout(attemptTimeoutMs),
        ]);
        return fetchImpl(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": apiKey },
          body,
          signal,
        });
      });
      const response = await pending;
      signal.throwIfAborted();
      if (response.ok) {
        const result = await response.json();
        signal.throwIfAborted();
        return result;
      }
      const retryAfter = response.headers.get("retry-after");
      // Release rejected bodies/connections without parsing or logging narratives.
      await response.body?.cancel();
      if (response.status !== 429 || attempt === 3)
        throw new Error(`Comparison HTTP ${response.status}`);
      let requestedDelay = 0;
      if (retryAfter) {
        const seconds = Number(retryAfter);
        requestedDelay = Number.isFinite(seconds)
          ? Math.max(0, seconds * 1000)
          : Math.max(0, Date.parse(retryAfter) - Date.now());
        if (!Number.isFinite(requestedDelay)) requestedDelay = 0;
      }
      // Honor Retry-After as a floor. The shared deadline also bounds long headers.
      await comparisonWait(
        Math.max(requestedDelay, 250 * 2 ** attempt) + Math.random() * 250,
        deadline,
      );
    }
    throw new Error("Comparison attempts exhausted");
  };
}
