const KEY = "good-neighbor-local-role";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Local identity selection is available only with explicit debug config on loopback. */
export function localRoleEnabled(
  config,
  hostname = globalThis.location?.hostname,
) {
  try {
    return (
      config.localDebugAdmin === true &&
      LOOPBACK.has(hostname) &&
      LOOPBACK.has(new URL(config.apiBase).hostname)
    );
  } catch {
    return false;
  }
}
export function getLocalRole() {
  try {
    return sessionStorage.getItem(KEY) === "manager" ? "manager" : "supervisor";
  } catch {
    return "supervisor";
  }
}
export function setLocalRole(role) {
  sessionStorage.setItem(KEY, role === "manager" ? "manager" : "supervisor");
}
export function localRoleHeaders(config) {
  if (!localRoleEnabled(config)) return {};
  if (getLocalRole() === "manager")
    return {
      "x-debug-groups": "compliance-manager",
      "x-debug-sub": "maya.manager@example.org",
      "x-debug-email": "maya.manager@example.org",
      "x-debug-first-name": "Maya",
      "x-debug-last-name": "Manager",
    };
  return {
    "x-debug-groups": "compliance-supervisor",
    "x-debug-sub": "local-admin",
  };
}
