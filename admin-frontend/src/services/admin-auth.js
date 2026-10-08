import { getAdminConfig } from "../config.js";

const ACCESS_TOKEN_KEY = "good-neighbor-admin-access-token";
const ID_TOKEN_KEY = "good-neighbor-admin-id-token";
const EXPIRES_AT_KEY = "good-neighbor-admin-expires-at";
const PKCE_VERIFIER_KEY = "good-neighbor-admin-pkce-verifier";
const OAUTH_STATE_KEY = "good-neighbor-admin-oauth-state";
const OAUTH_TRANSACTION_KEY = "good-neighbor-admin-oauth-transaction";
const OAUTH_TRANSACTION_TTL_MS = 30 * 60 * 1000;

/**
 * @returns {string}
 */
export function getAdminToken() {
  const expiresAt = Number(sessionStorage.getItem(EXPIRES_AT_KEY) || "0");
  if (expiresAt && Date.now() > expiresAt) {
    clearAdminSession();
    return "";
  }
  return sessionStorage.getItem(ACCESS_TOKEN_KEY) || "";
}

/**
 * @returns {boolean}
 */
export function hasAdminSession() {
  if (getAdminConfig().localDebugAdmin) return true;
  return Boolean(getAdminToken());
}

export function clearAdminSession() {
  sessionStorage.removeItem(ACCESS_TOKEN_KEY);
  sessionStorage.removeItem(ID_TOKEN_KEY);
  sessionStorage.removeItem(EXPIRES_AT_KEY);
  sessionStorage.removeItem(PKCE_VERIFIER_KEY);
  sessionStorage.removeItem(OAUTH_STATE_KEY);
  removeOAuthTransaction();
}

/**
 * Redirect to Cognito managed login using authorization-code + PKCE.
 */
export async function startAdminLogin() {
  const config = requireAuthConfig();
  const verifier = randomUrlSafe(64);
  const state = randomUrlSafe(24);
  const challenge = await sha256Base64Url(verifier);
  const transaction = { state, verifier, createdAt: Date.now() };
  sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);
  sessionStorage.setItem(OAUTH_STATE_KEY, state);
  writeOAuthTransaction(transaction);

  const url = new URL(`${config.cognitoDomain}/oauth2/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", challenge);
  location.assign(url.toString());
}

/**
 * Complete a Cognito authorization-code callback when `?code=` is present.
 * @returns {Promise<{ handled: boolean, error?: string }>}
 */
export async function completeAdminLoginFromUrl() {
  const params = new URLSearchParams(location.search);
  const error = params.get("error");
  if (error) return { handled: true, error };
  const code = params.get("code");
  if (!code) return { handled: false };

  const state = params.get("state") || "";
  const transaction = readOAuthTransaction();
  const expectedState = transaction?.state || "";
  const verifier = transaction?.verifier || "";
  if (!state || state !== expectedState || !verifier) {
    removeOAuthTransaction();
    clearCallbackParameters();
    return { handled: true, error: "invalid_login_state" };
  }
  // Consume the one-time state before exchanging the one-time code. This also
  // prevents a reconnecting custom element from processing the callback twice.
  removeOAuthTransaction();
  clearCallbackParameters();

  const config = requireAuthConfig();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  });
  const res = await fetch(`${config.cognitoDomain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const token = await res.json().catch(() => null);
  if (!res.ok || !token?.access_token) {
    clearAdminSession();
    return { handled: true, error: "token_exchange_failed" };
  }

  sessionStorage.setItem(ACCESS_TOKEN_KEY, token.access_token);
  if (token.id_token) sessionStorage.setItem(ID_TOKEN_KEY, token.id_token);
  sessionStorage.setItem(
    EXPIRES_AT_KEY,
    String(Date.now() + Number(token.expires_in || 3600) * 1000),
  );
  return { handled: true };
}

/**
 * Keep the PKCE transaction across Cognito's MFA navigation without moving
 * access or ID tokens out of sessionStorage. localStorage is a fallback for
 * browsers that replace the session context during the hosted-login journey.
 * @param {{ state: string, verifier: string, createdAt: number }} transaction
 */
function writeOAuthTransaction(transaction) {
  try {
    localStorage.setItem(OAUTH_TRANSACTION_KEY, JSON.stringify(transaction));
  } catch {
    // sessionStorage above remains the fallback in restricted browser modes.
  }
}

/** @returns {{ state: string, verifier: string } | null} */
function readOAuthTransaction() {
  const sessionState = sessionStorage.getItem(OAUTH_STATE_KEY) || "";
  const sessionVerifier = sessionStorage.getItem(PKCE_VERIFIER_KEY) || "";
  if (sessionState && sessionVerifier) {
    return { state: sessionState, verifier: sessionVerifier };
  }
  try {
    const value = JSON.parse(
      localStorage.getItem(OAUTH_TRANSACTION_KEY) || "null",
    );
    if (
      typeof value?.state === "string" &&
      typeof value?.verifier === "string" &&
      Number.isFinite(value?.createdAt) &&
      Date.now() - value.createdAt <= OAUTH_TRANSACTION_TTL_MS
    ) {
      return { state: value.state, verifier: value.verifier };
    }
  } catch {
    // Malformed or inaccessible storage is treated as an invalid transaction.
  }
  return null;
}

function removeOAuthTransaction() {
  sessionStorage.removeItem(PKCE_VERIFIER_KEY);
  sessionStorage.removeItem(OAUTH_STATE_KEY);
  try {
    localStorage.removeItem(OAUTH_TRANSACTION_KEY);
  } catch {
    // Ignore storage restrictions; there is no recoverable login transaction.
  }
}

function clearCallbackParameters() {
  history.replaceState(null, "", location.pathname || "/");
}

export function signOutAdmin() {
  const config = getAdminConfig();
  clearAdminSession();
  if (config.localDebugAdmin) {
    location.assign(config.logoutUri || location.href);
    return;
  }
  if (!config.cognitoDomain || !config.clientId) {
    location.assign(config.logoutUri || "/");
    return;
  }
  const url = new URL(`${config.cognitoDomain}/logout`);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("logout_uri", config.logoutUri);
  location.assign(url.toString());
}

/**
 * @returns {{ cognitoDomain: string, clientId: string, redirectUri: string, logoutUri: string, apiBase: string, localDebugAdmin: boolean }}
 */
function requireAuthConfig() {
  const config = getAdminConfig();
  if (!config.cognitoDomain || !config.clientId || !config.redirectUri) {
    throw new Error("missing_admin_auth_config");
  }
  return config;
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function randomUrlSafe(bytes) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return base64Url(values);
}

/**
 * @param {string} value
 * @returns {Promise<string>}
 */
async function sha256Base64Url(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return base64Url(new Uint8Array(digest));
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function base64Url(bytes) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
