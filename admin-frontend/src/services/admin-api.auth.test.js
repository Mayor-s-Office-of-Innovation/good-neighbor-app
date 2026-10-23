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
}

let fixtureId = 0;
async function fixture(t, options = {}) {
  globalThis.window = {
    GOOD_NEIGHBOR_ADMIN_CONFIG: {
      cognitoDomain: "https://login.example.test",
      clientId: "admin-client",
      redirectUri: "https://admin.example.test/auth/callback",
      apiBase: "https://admin.example.test",
      localDebugAdmin: options.debug || false,
    },
  };
  globalThis.sessionStorage = new MemoryStorage();
  globalThis.localStorage = new MemoryStorage();
  const redirects = [];
  let redirected;
  const navigation = new Promise((resolve) => {
    redirected = resolve;
  });
  globalThis.location = {
    assign(url) {
      redirects.push(url);
      redirected();
    },
  };
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    if (options.networkError) throw new TypeError("offline");
    return {
      ok: !options.status || options.status < 400,
      status: options.status || 200,
      json: async () => ({ error: options.error || "admin_error" }),
      blob: async () => "csv",
    };
  });
  const { adminApi } = await import(`./admin-api.js?auth-test=${++fixtureId}`);
  return { adminApi, redirects, navigation, calls };
}

function saveSession({ expired = false, accessExpired = false } = {}) {
  localStorage.setItem(
    "good-neighbor-admin-session",
    JSON.stringify({
      accessToken: "access",
      refreshToken: "refresh",
      accessExpiresAt: accessExpired ? 1 : Date.now() + 3600000,
      expiresAt: expired ? 1 : Date.now() + 86400000,
    }),
  );
}

for (const mode of [
  "missing",
  "expired",
  "refresh-rejected",
  "api-401",
  "csv-401",
]) {
  test(
    `redirects ${mode} to login once without completing failed operations`,
    { timeout: 2000 },
    async (t) => {
      const rejectedRefresh = mode === "refresh-rejected";
      const api401 = mode.endsWith("401");
      const f = await fixture(t, {
        status: rejectedRefresh ? 400 : api401 ? 401 : 200,
        error: rejectedRefresh ? "invalid_grant" : "unauthorized",
      });
      if (mode !== "missing")
        saveSession({
          expired: mode === "expired",
          accessExpired: rejectedRefresh,
        });
      let settled = false;
      const operation =
        mode === "csv-401"
          ? f.adminApi.downloadSiteImportConflicts("import-1")
          : f.adminApi.createProvider("Example");
      operation.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      f.adminApi.getSession().then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await f.navigation;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(f.redirects.length, 1);
      const url = new URL(f.redirects[0]);
      assert.equal(
        url.origin + url.pathname,
        "https://login.example.test/oauth2/authorize",
      );
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.ok(url.searchParams.get("state"));
      assert.equal(localStorage.getItem("good-neighbor-admin-session"), null);
      assert.equal(settled, false);
      if (!api401)
        assert.equal(
          f.calls.filter((call) => !call.url.endsWith("/oauth2/token")).length,
          0,
        );
      // The next operation must reuse the redirect, not create another OAuth transaction.
      void f.adminApi.getSession();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(f.redirects.length, 1);
    },
  );
}

for (const status of [403, 500]) {
  test(`does not redirect a ${status} response`, async (t) => {
    const f = await fixture(t, { status });
    saveSession();
    await assert.rejects(f.adminApi.getSession(), { message: "admin_error" });
    assert.equal(f.redirects.length, 0);
    assert.ok(localStorage.getItem("good-neighbor-admin-session"));
  });
}

test("transient refresh failures retain the session and do not redirect", async (t) => {
  const f = await fixture(t, { networkError: true });
  saveSession({ accessExpired: true });
  await assert.rejects(f.adminApi.getSession(), /offline/);
  assert.equal(f.redirects.length, 0);
  assert.ok(localStorage.getItem("good-neighbor-admin-session"));
});

test("local debug access works without Cognito tokens", async (t) => {
  const f = await fixture(t, { debug: true });
  await f.adminApi.getSession();
  assert.equal(f.redirects.length, 0);
  assert.equal(
    f.calls[0].init.headers["x-debug-groups"],
    "compliance-supervisor",
  );
});
