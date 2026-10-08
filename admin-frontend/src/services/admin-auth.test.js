import assert from "node:assert/strict";
import test from "node:test";

class MemoryStorage {
  values = new Map();

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }

  clear() {
    this.values.clear();
  }
}

test("completes Cognito MFA callback when sessionStorage was replaced", async () => {
  const session = new MemoryStorage();
  const local = new MemoryStorage();
  let assignedUrl = "";
  const location = {
    origin: "https://admin.example.test",
    pathname: "/auth/callback",
    search: "",
    href: "https://admin.example.test/auth/callback",
    assign(value) {
      assignedUrl = String(value);
    },
  };
  const history = {
    replaceState(_state, _title, path) {
      location.pathname = String(path);
      location.search = "";
    },
  };
  globalThis.window = {
    GOOD_NEIGHBOR_ADMIN_CONFIG: {
      cognitoDomain: "https://login.example.test",
      clientId: "client-1",
      redirectUri: "https://admin.example.test/auth/callback",
      logoutUri: "https://admin.example.test/",
    },
  };
  globalThis.location = location;
  globalThis.history = history;
  globalThis.sessionStorage = session;
  globalThis.localStorage = local;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ access_token: "access-1", expires_in: 3600 }),
  });

  const { completeAdminLoginFromUrl, startAdminLogin } = await import(
    `./admin-auth.js?test=${Date.now()}`
  );
  await startAdminLogin();
  const authorize = new URL(assignedUrl);

  // Cognito's MFA journey may return in a replaced session context. The
  // expiry-bound local transaction must still complete the PKCE exchange.
  session.clear();
  location.search = `?code=code-1&state=${authorize.searchParams.get("state")}`;
  const result = await completeAdminLoginFromUrl();

  assert.deepEqual(result, { handled: true });
  assert.equal(session.getItem("good-neighbor-admin-access-token"), "access-1");
  assert.equal(local.getItem("good-neighbor-admin-oauth-transaction"), null);
  assert.equal(location.search, "");
});
