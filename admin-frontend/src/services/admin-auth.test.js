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

const SESSION_KEY = "good-neighbor-admin-session";
const WEEK = 7 * 24 * 60 * 60 * 1000;

async function persistentFixture(t) {
  const fixture = callbackFixture(t);
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({
      access_token: "first-access",
      refresh_token: "refresh-1",
      expires_in: 3600,
    }),
  }));
  const auth = await import("./admin-auth.js");
  await auth.completeAdminLoginFromUrl();
  return { ...fixture, auth };
}

test("login survives browser closure and refresh keeps the original seven-day deadline", async (t) => {
  const { session, local, auth } = await persistentFixture(t);
  const saved = JSON.parse(local.getItem(SESSION_KEY));
  assert.ok(Math.abs(saved.expiresAt - Date.now() - WEEK) < 1000);
  session.clear();
  assert.equal(auth.hasAdminSession(), true);
  assert.equal(await auth.getFreshAdminToken(), "first-access");
  saved.accessExpiresAt = Date.now() + 30000;
  local.setItem(SESSION_KEY, JSON.stringify(saved));
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://login.example.test/oauth2/token");
    assert.equal(options.body.get("grant_type"), "refresh_token");
    assert.equal(options.body.get("refresh_token"), "refresh-1");
    return {
      ok: true,
      json: async () => ({ access_token: "renewed", expires_in: 3600 }),
    };
  });
  assert.deepEqual(
    await Promise.all([auth.getFreshAdminToken(), auth.getFreshAdminToken()]),
    ["renewed", "renewed"],
  );
  assert.equal(globalThis.fetch.mock.callCount(), 1);
  assert.equal(
    JSON.parse(local.getItem(SESSION_KEY)).expiresAt,
    saved.expiresAt,
  );
});

test("seven-day deadline clears even a still-valid access token without refreshing", async (t) => {
  const { local, auth } = await persistentFixture(t);
  const saved = JSON.parse(local.getItem(SESSION_KEY));
  saved.expiresAt = Date.now();
  local.setItem(SESSION_KEY, JSON.stringify(saved));
  const calls = globalThis.fetch.mock.callCount();
  assert.equal(auth.hasAdminSession(), false);
  assert.equal(await auth.getFreshAdminToken(), "");
  assert.equal(local.getItem(SESSION_KEY), null);
  assert.equal(globalThis.fetch.mock.callCount(), calls);
});

for (const failure of ["network", "server", "invalid_grant"]) {
  test(`refresh handles ${failure} without extending the session`, async (t) => {
    const { local, auth } = await persistentFixture(t);
    const saved = JSON.parse(local.getItem(SESSION_KEY));
    saved.accessExpiresAt = 1;
    local.setItem(SESSION_KEY, JSON.stringify(saved));
    t.mock.method(globalThis, "fetch", async () => {
      if (failure === "network") throw new TypeError("offline");
      return {
        ok: false,
        status: failure === "server" ? 503 : 400,
        json: async () => ({ error: failure }),
      };
    });
    if (failure === "invalid_grant") {
      assert.equal(await auth.getFreshAdminToken(), "");
      assert.equal(auth.hasAdminSession(), false);
    } else {
      await assert.rejects(auth.getFreshAdminToken());
      assert.equal(auth.hasAdminSession(), true);
      assert.deepEqual(JSON.parse(local.getItem(SESSION_KEY)), saved);
      t.mock.method(globalThis, "fetch", async () => ({
        ok: true,
        json: async () => ({ access_token: "retried", expires_in: 3600 }),
      }));
      assert.equal(await auth.getFreshAdminToken(), "retried");
    }
  });
}

test("sign-out revokes refresh credentials and an in-flight refresh cannot restore them", async (t) => {
  const { local, auth, location } = await persistentFixture(t);
  const saved = JSON.parse(local.getItem(SESSION_KEY));
  saved.accessExpiresAt = 1;
  local.setItem(SESSION_KEY, JSON.stringify(saved));
  let finish;
  let revoked = false;
  location.assign = () => {};
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.endsWith("/revoke")) {
      revoked = true;
      assert.equal(options.body.get("token"), "refresh-1");
      return { ok: true };
    }
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const pending = auth.getFreshAdminToken();
  auth.signOutAdmin();
  finish({
    ok: true,
    json: async () => ({ access_token: "too-late", expires_in: 3600 }),
  });
  assert.equal(await pending, "");
  assert.equal(revoked, true);
  assert.equal(local.getItem(SESSION_KEY), null);
  assert.equal(auth.hasAdminSession(), false);
});

test("API calls and CSV downloads refresh credentials before sending authorization", async (t) => {
  const { local } = await persistentFixture(t);
  const { adminApi } = await import("./admin-api.js");
  let refreshes = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.endsWith("/oauth2/token")) {
      refreshes++;
      return {
        ok: true,
        json: async () => ({ access_token: "api-access", expires_in: 3600 }),
      };
    }
    assert.equal(options.headers.authorization, "Bearer api-access");
    return {
      ok: true,
      json: async () => ({ ok: true }),
      blob: async () => "csv",
    };
  });
  for (const request of [
    () => adminApi.getSession(),
    () => adminApi.downloadSiteImportConflicts("import-1"),
  ]) {
    const saved = JSON.parse(local.getItem(SESSION_KEY));
    saved.accessExpiresAt = 1;
    local.setItem(SESSION_KEY, JSON.stringify(saved));
    await request();
  }
  assert.equal(refreshes, 2);
});

test("restricted persistent storage falls back to a refreshable tab session", async (t) => {
  const { local, session } = callbackFixture(t);
  session.setItem("good-neighbor-admin-oauth-state", "current-state");
  session.setItem("good-neighbor-admin-pkce-verifier", "current-verifier");
  for (const method of ["getItem", "setItem", "removeItem"]) {
    t.mock.method(local, method, () => {
      throw new Error("storage blocked");
    });
  }
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({
      access_token: "tab-access",
      refresh_token: "tab-refresh",
      expires_in: 3600,
    }),
  }));
  const auth = await import("./admin-auth.js");
  assert.deepEqual(await auth.completeAdminLoginFromUrl(), { handled: true });
  assert.equal(await auth.getFreshAdminToken(), "tab-access");
  assert.ok(session.getItem(SESSION_KEY));
  auth.clearAdminSession();
  assert.equal(auth.hasAdminSession(), false);
});

test("a stale refresh failure cannot erase a newer login in another tab", async (t) => {
  const { local, auth } = await persistentFixture(t);
  const saved = JSON.parse(local.getItem(SESSION_KEY));
  saved.accessExpiresAt = 1;
  local.setItem(SESSION_KEY, JSON.stringify(saved));
  let finish;
  t.mock.method(
    globalThis,
    "fetch",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = auth.getFreshAdminToken();
  const newer = {
    ...saved,
    refreshToken: "new-login",
    accessToken: "new-access",
    accessExpiresAt: Date.now() + 3600000,
  };
  local.setItem(SESSION_KEY, JSON.stringify(newer));
  finish({ ok: false, json: async () => ({ error: "invalid_grant" }) });
  assert.equal(await pending, "");
  assert.deepEqual(JSON.parse(local.getItem(SESSION_KEY)), newer);
  assert.equal(await auth.getFreshAdminToken(), "new-access");
});
