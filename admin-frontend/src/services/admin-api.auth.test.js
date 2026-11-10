// @vitest-environment node
import assert from "node:assert/strict";
import { test, vi } from "vitest";

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

async function fixture(options = {}) {
  vi.stubGlobal("window", {
    GOOD_NEIGHBOR_ADMIN_CONFIG: {
      cognitoDomain: "https://login.example.test",
      clientId: "admin-client",
      redirectUri: "https://admin.example.test/auth/callback",
      apiBase: options.debug
        ? "http://localhost:3001"
        : "https://admin.example.test",
      localDebugAdmin: options.debug || false,
    },
  });
  vi.stubGlobal("sessionStorage", new MemoryStorage());
  vi.stubGlobal("localStorage", new MemoryStorage());
  const redirects = [];
  let redirected;
  const navigation = new Promise((resolve) => {
    redirected = resolve;
  });
  vi.stubGlobal("location", {
    hostname: "localhost",
    assign(url) {
      redirects.push(url);
      redirected();
    },
  });
  const calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    calls.push({ url, init });
    if (options.networkError) throw new TypeError("offline");
    if (options.responseBody !== undefined)
      return new Response(options.responseBody, { status: options.status });
    return {
      ok: !options.status || options.status < 400,
      status: options.status || 200,
      headers: {
        get: (name) =>
          name.toLowerCase() === "retry-after" ? options.retryAfter : null,
      },
      json: async () => ({ error: options.error || "admin_error" }),
      blob: async () => "csv",
    };
  });
  // A fresh backend-health.js too: an earlier test's disconnect must not carry over.
  vi.resetModules();
  const { adminApi } = await import("./admin-api.js");
  const { connectionSnapshot } = await import(
    "../../../frontend/src/services/backend-health.js"
  );
  return { adminApi, connectionSnapshot, redirects, navigation, calls };
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
    async () => {
      const rejectedRefresh = mode === "refresh-rejected";
      const api401 = mode.endsWith("401");
      const f = await fixture({
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

for (const status of [403, 429, 500]) {
  test(`does not redirect a ${status} response`, async () => {
    const f = await fixture({ status });
    saveSession();
    await assert.rejects(f.adminApi.getSession(), { message: "admin_error" });
    assert.equal(f.redirects.length, 0);
    assert.ok(localStorage.getItem("good-neighbor-admin-session"));
  });
}

for (const [status, responseBody, code] of [
  [403, "<html>Request blocked</html>", "request_blocked"],
  [413, "<html>Payload too large</html>", "request_too_large"],
  [413, JSON.stringify({ error: "request_too_large" }), "request_too_large"],
  [
    403,
    JSON.stringify({ error: "supervisor_required" }),
    "supervisor_required",
  ],
  [403, "null", "request_blocked"],
]) {
  test(`import rejection ${status} (${responseBody}) keeps connectivity and session`, async () => {
    const f = await fixture({ status, responseBody });
    saveSession();
    assert.equal(f.connectionSnapshot().disconnected, false);
    await assert.rejects(
      f.adminApi.previewSiteImport("sites.csv", "synthetic"),
      {
        message: code,
        status,
      },
    );
    assert.equal(f.connectionSnapshot().disconnected, false);
    assert.equal(f.redirects.length, 0);
    assert.ok(localStorage.getItem("good-neighbor-admin-session"));
    assert.equal(f.calls.length, 1);
  });
}

test("transient refresh failures retain the session and do not redirect", async () => {
  const f = await fixture({ networkError: true });
  saveSession({ accessExpired: true });
  await assert.rejects(f.adminApi.getSession(), /offline/);
  assert.equal(f.redirects.length, 0);
  assert.ok(localStorage.getItem("good-neighbor-admin-session"));
});

test("local debug access works without Cognito tokens", async () => {
  const f = await fixture({ debug: true });
  await f.adminApi.getSession();
  assert.equal(f.redirects.length, 0);
  assert.equal(
    f.calls[0].init.headers["x-debug-groups"],
    "compliance-supervisor",
  );
});

test("exposes a throttle cooldown without retrying or redirecting", async () => {
  const f = await fixture({ status: 429, retryAfter: "300" });
  saveSession();
  await assert.rejects(f.adminApi.getSession(), {
    status: 429,
    retryAfterMs: 300000,
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.redirects.length, 0);
});
