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

test("clears an expired session before creating a new login transaction", async () => {
  const session = new MemoryStorage();
  const local = new MemoryStorage();
  let assignedUrl = "";
  const location = {
    origin: "https://admin.example.test",
    pathname: "/",
    search: "",
    href: "https://admin.example.test/",
    assign(value) {
      assignedUrl = String(value);
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
  globalThis.history = {
    replaceState(_state, _title, path) {
      location.pathname = String(path);
      location.search = "";
    },
  };
  globalThis.sessionStorage = session;
  globalThis.localStorage = local;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ access_token: "access-2", expires_in: 3600 }),
  });

  session.setItem("good-neighbor-admin-access-token", "expired-access");
  session.setItem("good-neighbor-admin-expires-at", "1");

  const { completeAdminLoginFromUrl, hasAdminSession, startAdminLogin } =
    await import(`./admin-auth.js?expired-session-test=${Date.now()}`);
  await startAdminLogin();
  const authorize = new URL(assignedUrl);
  location.pathname = "/auth/callback";
  location.search = `?code=code-2&state=${authorize.searchParams.get("state")}`;

  // AdminApp performs this session check before it handles the callback.
  assert.equal(hasAdminSession(), false);
  assert.deepEqual(await completeAdminLoginFromUrl(), { handled: true });
  assert.equal(session.getItem("good-neighbor-admin-access-token"), "access-2");
});

function callbackFixture(t) {
  globalThis.window = {
    GOOD_NEIGHBOR_ADMIN_CONFIG: {
      cognitoDomain: "https://login.example.test",
      clientId: "client-1",
      redirectUri: "https://admin.example.test/auth/callback",
    },
  };
  const session = new MemoryStorage();
  const local = new MemoryStorage();
  const location = {
    origin: "https://admin.example.test",
    pathname: "/auth/callback",
    search: "?code=current-code&state=current-state",
  };
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.body.get("code_verifier"), "current-verifier");
    return {
      ok: true,
      json: async () => ({ access_token: "current-access", expires_in: 3600 }),
    };
  });
  globalThis.sessionStorage = session;
  globalThis.localStorage = local;
  globalThis.location = location;
  globalThis.history = {
    replaceState() {
      location.search = "";
    },
  };
  local.setItem(
    "good-neighbor-admin-oauth-transaction",
    JSON.stringify({
      state: "current-state",
      verifier: "current-verifier",
      createdAt: Date.now(),
    }),
  );
  return { session, local, location };
}

test("session expiry during callback startup does not erase the pending login", async (t) => {
  const { session } = callbackFixture(t);
  session.setItem("good-neighbor-admin-access-token", "expired-access");
  session.setItem("good-neighbor-admin-expires-at", "1");
  const { hasAdminSession, completeAdminLoginFromUrl } = await import(
    "./admin-auth.js"
  );

  assert.equal(hasAdminSession(), false);
  assert.deepEqual(await completeAdminLoginFromUrl(), { handled: true });
  assert.equal(
    session.getItem("good-neighbor-admin-access-token"),
    "current-access",
  );
});

test("stale tab state does not mask a matching unexpired fallback", async (t) => {
  const { session } = callbackFixture(t);
  session.setItem("good-neighbor-admin-oauth-state", "previous-state");
  session.setItem("good-neighbor-admin-pkce-verifier", "previous-verifier");
  const { completeAdminLoginFromUrl } = await import("./admin-auth.js");

  assert.deepEqual(await completeAdminLoginFromUrl(), { handled: true });
  assert.equal(
    session.getItem("good-neighbor-admin-access-token"),
    "current-access",
  );
});

test("mismatched callback cannot consume a pending login", async (t) => {
  const { local, location } = callbackFixture(t);
  location.search = "?code=old-code&state=old-state";
  const { completeAdminLoginFromUrl } = await import("./admin-auth.js");

  assert.deepEqual(await completeAdminLoginFromUrl(), {
    handled: true,
    error: "invalid_login_state",
  });
  assert.equal(globalThis.fetch.mock.callCount(), 0);
  assert.ok(local.getItem("good-neighbor-admin-oauth-transaction"));
  location.search = "?code=current-code&state=current-state";
  assert.deepEqual(await completeAdminLoginFromUrl(), { handled: true });
});

test("expired fallback still rejects the callback without exchanging tokens", async (t) => {
  const { local } = callbackFixture(t);
  const transaction = JSON.parse(
    local.getItem("good-neighbor-admin-oauth-transaction"),
  );
  transaction.createdAt = Date.now() - 31 * 60 * 1000;
  local.setItem(
    "good-neighbor-admin-oauth-transaction",
    JSON.stringify(transaction),
  );
  const { completeAdminLoginFromUrl } = await import("./admin-auth.js");

  assert.deepEqual(await completeAdminLoginFromUrl(), {
    handled: true,
    error: "invalid_login_state",
  });
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("successful callback consumes its transaction and rejects replay", async (t) => {
  const { location } = callbackFixture(t);
  const callbackSearch = location.search;
  const { completeAdminLoginFromUrl } = await import("./admin-auth.js");

  assert.deepEqual(await completeAdminLoginFromUrl(), { handled: true });
  location.search = callbackSearch;
  assert.deepEqual(await completeAdminLoginFromUrl(), {
    handled: true,
    error: "invalid_login_state",
  });
  assert.equal(globalThis.fetch.mock.callCount(), 1);
});
