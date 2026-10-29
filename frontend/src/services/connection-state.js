/** Reachability is separate from authentication and operation/write success. */
/** @type {Map<string, string>} */
const failures = new Map();
/** @type {Map<string, string>} */
const endpoints = new Map();
const cooldowns = new Map();
/** @type {Set<(state: {disconnected: boolean}) => void>} */
const listeners = new Set();
let installed = false;
let failureGeneration = 0;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let timer;
/** @type {Promise<unknown> | undefined} */
let retrying;
export const connectionSnapshot = () => ({
  disconnected: globalThis.navigator?.onLine === false || failures.size > 0,
});
const emit = () => listeners.forEach((fn) => fn(connectionSnapshot()));
/** @param {(state: {disconnected: boolean}) => void} fn */
export function onConnectionChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function connectionFailed(service = "api", probeUrl = "") {
  failureGeneration += 1;
  const first = !failures.has(service);
  failures.set(service, probeUrl);
  if (first) emit();
  if (installed && !timer)
    timer = setTimeout(() => {
      timer = undefined;
      void retryConnection();
    }, 30000);
}
export function connectionSucceeded(
  service = "api",
  generation = failureGeneration,
) {
  // Loopback and in-flight responses do not prove recovery from browser offline.
  if (
    globalThis.navigator?.onLine === false ||
    generation !== failureGeneration
  )
    return;
  cooldowns.delete(service);
  const changed = failures.delete(service);
  if (changed) failures.delete("browser");
  if (!failures.size) {
    clearTimeout(timer);
    timer = undefined;
  }
  if (changed) emit();
}
export async function retryConnection() {
  if (globalThis.navigator?.onLine === false) return;
  const generation = failureGeneration;
  if (retrying) return retrying;
  const recovered = new Set();
  retrying = Promise.all(
    [...failures].map(async ([service, url]) => {
      if (!url || (cooldowns.get(service) || 0) > Date.now()) return;
      try {
        const originProbe =
          service.startsWith("upload:") || service.startsWith("auth:");
        // Browsers require follow mode for no-cors GETs. Credentials stay
        // omitted across redirects; no signed path, headers or body are reused.
        const response = await fetch(url, {
          ...(originProbe
            ? { mode: "no-cors", credentials: "omit", redirect: "follow" }
            : {}),
          cache: "no-store",
          signal: AbortSignal.timeout(10000),
        });
        if (response.status === 429) {
          const advice = response.headers.get("retry-after");
          const seconds = Number(advice);
          const delay =
            advice && Number.isFinite(seconds)
              ? seconds * 1000
              : Math.max(0, Date.parse(advice || "") - Date.now());
          cooldowns.set(
            service,
            Date.now() +
              (Number.isFinite(delay) ? Math.max(1000, delay) : 300000),
          );
        } else if (
          (originProbe && response.type !== "error") ||
          (!originProbe &&
            response.ok &&
            (await response.json().catch(() => null))?.ok === true)
        ) {
          cooldowns.delete(service);
          connectionSucceeded(service, generation);
          if (!failures.has(service)) recovered.add(service);
        }
      } catch {
        /* No optimistic online state: this service has not recovered. */
      }
    }),
  ).finally(() => {
    retrying = undefined;
    if (
      globalThis.navigator?.onLine !== false &&
      generation === failureGeneration &&
      [...recovered].some((service) => !service.startsWith("auth:")) &&
      ![...failures.keys()].some((service) => !service.startsWith("auth:"))
    )
      globalThis.window?.dispatchEvent(new Event("connectionretry"));
    if (installed && failures.size && !timer)
      timer = setTimeout(() => {
        timer = undefined;
        void retryConnection();
      }, 30000);
  });
  return retrying;
}
/** Service keys and probes contain no signed URLs or credentials.
 * Opaque GETs prove host reachability only, never authentication or write success.
 * @param {string} value
 */
export function connectionTarget(value) {
  const url = new URL(value, globalThis.location?.href || "http://localhost");
  if (url.pathname === "/oauth2/token")
    return { service: `auth:${url.origin}`, probeUrl: `${url.origin}/` };
  if (url.pathname.endsWith("/health")) {
    const prefix = url.pathname.slice(0, -7);
    return {
      service: `api:${url.origin}${prefix}`,
      probeUrl: `${url.origin}${prefix}/health`,
    };
  }
  const match = url.pathname.match(
    /^(.*?)\/(?:admin\/|app\/)?v1(?:\/|$)|^(.*?)\/site-code$/,
  );
  if (!match)
    return { service: `upload:${url.origin}`, probeUrl: `${url.origin}/` };
  const prefix = match[1] ?? match[2] ?? "";
  return {
    service: `api:${url.origin}${prefix}`,
    probeUrl: `${url.origin}${prefix}/health`,
  };
}
/** Explicitly observed requests exclude telemetry. HTTP errors are reachable, not transport loss.
 * @param {RequestInfo | URL} input
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function connectionFetch(input, init = {}) {
  const generation = failureGeneration;
  const target = connectionTarget(
    typeof input === "string" || input instanceof URL
      ? String(input)
      : input.url,
  );
  if (target.probeUrl) endpoints.set(target.service, target.probeUrl);
  try {
    const response = await fetch(input, init);
    connectionSucceeded(target.service, generation);
    return response;
  } catch (error) {
    if (
      error?.name !== "AbortError" &&
      (!init.signal?.aborted || init.signal.reason?.name === "TimeoutError")
    )
      connectionFailed(target.service, target.probeUrl);
    throw error;
  }
}
export function startConnectionMonitoring() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const offline = () => {
    connectionFailed("browser", endpoints.values().next().value || "/health");
    for (const [service, url] of endpoints) connectionFailed(service, url);
  };
  window.addEventListener("offline", offline);
  window.addEventListener("online", () => {
    void retryConnection();
  });
  if (navigator.onLine === false) offline();
}
