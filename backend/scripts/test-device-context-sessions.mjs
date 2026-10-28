// Real DynamoDB Local transactions + production handlers. This deliberately
// starts an isolated in-memory emulator, never the developer's persistent DB.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import DynamoDbLocal from "dynamodb-local";
import {
  DynamoDBClient,
  CreateTableCommand,
  ListTablesCommand,
} from "@aws-sdk/client-dynamodb";
import { PutCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const portProbe = createServer();
await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
const port = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const endpoint = `http://127.0.0.1:${port}`;
Object.assign(process.env, {
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "sessiontest",
  AWS_SECRET_ACCESS_KEY: "session-test-only",
  AWS_SESSION_TOKEN: "",
  AWS_ENDPOINT_URL_DYNAMODB: endpoint,
  DYNAMO_TABLE: "gnp-local-context-session-test",
  DEVICE_TOKEN_SECRET: "synthetic-local-context-session-key-32-bytes",
});
DynamoDbLocal.configureInstaller({
  installPath: fileURLToPath(
    new URL("../.local/dynamodb-local", import.meta.url),
  ),
});
const client = new DynamoDBClient({
  endpoint,
  region: "us-east-1",
  maxAttempts: 1,
  credentials: {
    accessKeyId: "sessiontest",
    secretAccessKey: "session-test-only",
  },
});

await test("managed device sessions against isolated DynamoDB Local", async (t) => {
  await DynamoDbLocal.launch(port, null, ["-sharedDb"]);
  const { ddb } = await import("../src/db.js");
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await client.send(new ListTablesCommand({}));
        break;
      } catch (error) {
        if (attempt > 100) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await client.send(
      new CreateTableCommand({
        TableName: process.env.DYNAMO_TABLE,
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );
    const table = process.env.DYNAMO_TABLE;
    const put = (Item) => ddb.send(new PutCommand({ TableName: table, Item }));
    const get = async (pk, sk) =>
      (
        await ddb.send(
          new GetCommand({
            TableName: table,
            Key: { pk, sk },
            ConsistentRead: true,
          }),
        )
      ).Item;
    const { mintAccessToken, mintRefreshToken, verifyDeviceToken } =
      await import("../src/lib/device-token.js");
    const { handler: authorize } = await import("../src/lambda/authorizer.js");
    const { issueSessionHandoff, redeemSessionHandoff, retireSessionHandoff } =
      await import("../src/handlers/session-handoff.js");
    const { refreshDeviceToken, registerDevice } = await import(
      "../src/handlers/devices.js"
    );
    const { selectDeviceBinding } = await import(
      "../src/handlers/device-bindings.js"
    );
    const { listGeneralBindings, revokeGeneralBinding } = await import(
      "../src/handlers/manager-access.js"
    );
    const { revokeProviderManagerEnrollment } = await import(
      "../src/handlers/admin-provider-managers.js"
    );
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 365 * 86400000).toISOString();
    const responseBody = (response) => {
      assert.equal(response.statusCode, 200, response.body);
      return JSON.parse(response.body);
    };
    const allowed = async (token) =>
      (await authorize({ headers: { authorization: `Bearer ${token}` } }))
        .isAuthorized;
    const eventFor = async (token, body = {}, pathParameters = {}) => {
      const verdict = await authorize({
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(verdict.isAuthorized, true);
      return {
        body: JSON.stringify(body),
        pathParameters,
        requestContext: { authorizer: { lambda: verdict.context } },
      };
    };
    const supervisor = (pathParameters, body = {}) => ({
      body: JSON.stringify(body),
      pathParameters,
      requestContext: {
        authorizer: {
          jwt: {
            claims: {
              sub: "test-supervisor",
              "cognito:groups": "compliance-supervisor",
            },
          },
        },
      },
    });
    const seed = async (siteId, id, provider = false) => {
      const subject = {
        siteId,
        deviceId: id,
        tokenGeneration: 1,
        accessLevel: provider ? "manager" : "general",
      };
      const [access, refresh] = await Promise.all([
        mintAccessToken(subject),
        mintRefreshToken(subject),
      ]);
      const common = {
        siteId,
        bindingId: id,
        physicalDeviceId: "physical",
        label: "Bob's phone",
        accessLevel: subject.accessLevel,
        status: "active",
        tokenGeneration: 1,
        refreshJti: refresh.jti,
        lastSeenAt: now,
        absoluteExpiresAt: future,
        inactivityLimitDays: 60,
        siteCredentialGeneration: 0,
        ...(provider
          ? {
              authorityScope: "provider",
              providerId: "provider",
              providerMembershipId: "member",
              providerMembershipGeneration: 1,
              providerAccessGeneration: 0,
              providerEnrollmentId: "enrollment",
            }
          : {}),
      };
      await put({
        pk: `SITE#${siteId}`,
        sk: "#META",
        siteId,
        name: "Synthetic site",
        status: "active",
        siteCredentialGeneration: 0,
        providerId: "provider",
        providerAccessGeneration: 0,
      });
      await put({
        ...common,
        pk: `SITE#${siteId}`,
        sk: `DEVICE#${id}`,
        type: "device",
        deviceId: id,
        siteName: "Synthetic site",
        registeredAt: now,
      });
      await put({
        ...common,
        pk: `SITE#${siteId}`,
        sk: `DEVICE_BINDING#${id}`,
        type: "deviceBinding",
        enrolledAt: now,
      });
      await put({
        ...common,
        pk: "PHYSICAL_DEVICE#physical",
        sk: `BINDING#${id}`,
        type: "physicalDeviceBindingPointer",
      });
      return { ...subject, token: access.token, refreshToken: refresh.token };
    };
    const handoff = async (browser) => {
      const issued = responseBody(
        await issueSessionHandoff(await eventFor(browser.token)),
      );
      const response = await redeemSessionHandoff({
        body: "{}",
        cookies: [`__Secure-gnp-handoff=${issued.grantId}.${issued.token}`],
        requestContext: {},
      });
      const home = responseBody(response);
      assert.equal(home.deviceId, browser.deviceId);
      assert.equal(home.bindingId, browser.deviceId);
      assert.equal(home.physicalDeviceId, "physical");
      assert.ok((await verifyDeviceToken(home.token)).sid);
      return home;
    };
    const refresh = async (session) =>
      responseBody(
        await refreshDeviceToken({
          body: JSON.stringify({ refreshToken: session.refreshToken }),
          requestContext: {},
        }),
      );
    await put({
      pk: "PHYSICAL_DEVICE#physical",
      sk: "#META",
      physicalDeviceId: "physical",
      status: "active",
    });
    await put({
      pk: "PROVIDER#provider",
      sk: "PROVIDER_MANAGER#member",
      membershipId: "member",
      status: "active",
      generation: 1,
    });
    let browser = await seed("a", "binding-a", true);
    const browserB = await seed("b", "binding-b", true);
    await put({
      pk: "PROVIDER#provider",
      sk: "PROVIDER_MANAGER_ENROLLMENT#enrollment",
      status: "active",
      membershipId: "member",
      physicalDeviceId: "physical",
      siteBindings: [
        { siteId: "a", bindingId: "binding-a" },
        { siteId: "b", bindingId: "binding-b" },
      ],
    });
    const recoverRefresh = (session, attemptId) =>
      refreshDeviceToken({
        body: JSON.stringify({
          refreshToken: session.refreshToken,
          ...(attemptId !== undefined ? { attemptId } : {}),
        }),
        requestContext: {},
      });
    await t.test(
      "REPRO: discarding a committed legacy refresh leaves the browser unable to retry",
      async () => {
        const source = await seed("lost-legacy", "lost-legacy");
        assert.equal((await recoverRefresh(source)).statusCode, 200); // response discarded before local save
        assert.equal((await recoverRefresh(source)).statusCode, 401);
      },
    );
    for (const kind of ["browser", "home_screen"]) {
      await t.test(
        `${kind}: a discarded response recovers the identical pair with no second rotation`,
        async () => {
          const source = await seed(`recovery-${kind}`, `recovery-${kind}`);
          const session = kind === "browser" ? source : await handoff(source);
          const attempt = randomUUID();
          const committed = responseBody(
            await recoverRefresh(session, attempt),
          );
          const recovered = responseBody(
            await recoverRefresh(session, attempt),
          );
          assert.equal(recovered.token, committed.token);
          assert.equal(recovered.refreshToken, committed.refreshToken);
          assert.equal(recovered.tokenGeneration, session.tokenGeneration + 1);
          assert.equal(await allowed(recovered.token), true);
          const row = await get(
            `SITE#recovery-${kind}`,
            `DEVICE#recovery-${kind}`,
          );
          assert.ok(!JSON.stringify(row).includes(committed.refreshToken));
          assert.ok(!JSON.stringify(row).includes(committed.token));
          assert.ok(!JSON.stringify(row).includes(attempt));
          assert.equal(
            (await recoverRefresh(session, randomUUID())).statusCode,
            401,
          );
          assert.equal((await recoverRefresh(session)).statusCode, 401);
          assert.equal(
            (await recoverRefresh(session, "invalid-attempt")).statusCode,
            400,
          );
          assert.equal(
            (await recoverRefresh(committed, attempt)).statusCode,
            401,
          ); // cannot reuse ID for another rotation
          const replacement = responseBody(
            await recoverRefresh(committed, randomUUID()),
          );
          assert.equal(
            replacement.tokenGeneration,
            committed.tokenGeneration + 1,
          );
          assert.equal(
            (await recoverRefresh(session, attempt)).statusCode,
            401,
          ); // superseded
          if (kind === "home_screen")
            assert.equal(await allowed(source.token), true);
        },
      );
      await t.test(
        `${kind}: concurrent matching retries converge on one committed rotation`,
        async () => {
          const source = await seed(`parallel-${kind}`, `parallel-${kind}`);
          const session = kind === "browser" ? source : await handoff(source);
          const attempt = randomUUID();
          const results = await Promise.all(
            Array.from({ length: 4 }, () => recoverRefresh(session, attempt)),
          );
          const payloads = [];
          for (const result of results) {
            assert.ok([200, 409].includes(result.statusCode), result.body);
            payloads.push(
              responseBody(
                result.statusCode === 409
                  ? await recoverRefresh(session, attempt)
                  : result,
              ),
            );
          }
          assert.equal(new Set(payloads.map((p) => p.refreshToken)).size, 1);
          assert.equal(
            payloads[0].tokenGeneration,
            session.tokenGeneration + 1,
          );
        },
      );
      for (const mutation of [
        "revoked",
        "suspended",
        "deleted",
        "signed_out",
        "site_generation",
        "site_inactive",
        "absolute_expiry",
        "idle",
        "receipt_expired",
        "receipt_tampered",
        ...(kind === "home_screen" ? ["context_expired"] : []),
      ]) {
        await t.test(`${kind}: recovery refuses ${mutation}`, async () => {
          const id = `deny-${kind}-${mutation}`;
          const source = await seed(id, id);
          const session = kind === "browser" ? source : await handoff(source);
          const attempt = randomUUID();
          const committed = responseBody(
            await recoverRefresh(session, attempt),
          );
          const row = await get(`SITE#${id}`, `DEVICE#${id}`);
          const sid = (await verifyDeviceToken(session.token)).sid;
          const state = sid ? row.sessions[sid] : row;
          if (["revoked", "suspended"].includes(mutation))
            row.status = mutation;
          if (mutation === "absolute_expiry")
            row.absoluteExpiresAt = new Date(Date.now() - 1000).toISOString();
          if (mutation === "idle")
            row.lastSeenAt = new Date(Date.now() - 61 * 86400000).toISOString();
          if (mutation === "receipt_expired")
            state.refreshRecovery.expiresAt = Math.floor(Date.now() / 1000) - 1;
          if (mutation === "receipt_tampered")
            state.refreshRecovery.ciphertext = "broken";
          if (mutation === "context_expired")
            state.expiresAt = new Date(Date.now() - 1000).toISOString();
          await put(row);
          if (mutation === "deleted") {
            const { DeleteCommand } = await import("@aws-sdk/lib-dynamodb");
            await ddb.send(
              new DeleteCommand({
                TableName: table,
                Key: { pk: row.pk, sk: row.sk },
              }),
            );
          }
          if (mutation === "signed_out")
            responseBody(
              await retireSessionHandoff(
                await eventFor(committed.token, { endSession: true }),
              ),
            );
          if (mutation === "site_generation" || mutation === "site_inactive") {
            const site = await get(`SITE#${id}`, "#META");
            await put({
              ...site,
              ...(mutation === "site_generation"
                ? { siteCredentialGeneration: 1 }
                : { status: "inactive" }),
            });
          }
          assert.equal(
            (await recoverRefresh(session, attempt)).statusCode,
            401,
          );
        });
      }
      await t.test(
        `${kind}: Site Manager device revocation denies recovery and current refresh`,
        async () => {
          const id = `manager-revoke-${kind}`;
          const source = await seed(id, id);
          const session = kind === "browser" ? source : await handoff(source);
          const attempt = randomUUID();
          const committed = responseBody(
            await recoverRefresh(session, attempt),
          );
          responseBody(
            await revokeGeneralBinding({
              body: "{}",
              pathParameters: { bindingId: id },
              requestContext: {
                authorizer: {
                  jwt: {
                    claims: {
                      "custom:siteId": id,
                      sub: "manager",
                      accessLevel: "manager",
                    },
                  },
                },
              },
            }),
          );
          assert.equal(
            (await recoverRefresh(session, attempt)).statusCode,
            401,
          );
          assert.equal(
            (await recoverRefresh(committed, randomUUID())).statusCode,
            401,
          );
        },
      );
    }
    await t.test(
      "recovery preserves original token expiry instead of extending it",
      async () => {
        const id = "recovery-ttl";
        const source = await seed(id, id);
        const attempt = randomUUID();
        const committed = responseBody(await recoverRefresh(source, attempt));
        const realNow = Date.now;
        let recovered;
        try {
          Date.now = () => realNow() + 60000;
          recovered = responseBody(await recoverRefresh(source, attempt));
        } finally {
          Date.now = realNow;
        }
        assert.ok(recovered.expiresIn <= committed.expiresIn - 60);
        assert.ok(
          recovered.refreshExpiresIn <= committed.refreshExpiresIn - 60,
        );
        assert.equal(recovered.token, committed.token);
      },
    );
    await t.test(
      "an expired original token cannot recover even within the receipt window",
      async () => {
        const id = "expired-original";
        const source = await seed(id, id);
        const short = await mintRefreshToken(source, { expiresIn: 2 });
        source.refreshToken = short.token;
        const row = await get(`SITE#${id}`, `DEVICE#${id}`);
        await put({ ...row, refreshJti: short.jti });
        const attempt = randomUUID();
        responseBody(await recoverRefresh(source, attempt));
        const realNow = Date.now;
        try {
          Date.now = () => realNow() + 3000;
          assert.equal((await recoverRefresh(source, attempt)).statusCode, 401);
        } finally {
          Date.now = realNow;
        }
      },
    );
    await t.test(
      "extending receipt metadata cannot extend the encrypted five-minute window",
      async () => {
        const id = "encrypted-deadline";
        const source = await seed(id, id);
        const attempt = randomUUID();
        responseBody(await recoverRefresh(source, attempt));
        const row = await get(`SITE#${id}`, `DEVICE#${id}`);
        row.refreshRecovery.expiresAt += 86400;
        await put(row);
        const realNow = Date.now;
        try {
          Date.now = () => realNow() + 301000;
          assert.equal((await recoverRefresh(source, attempt)).statusCode, 401);
        } finally {
          Date.now = realNow;
        }
      },
    );
    await t.test(
      "different attempt IDs cannot recover another caller's committed rotation",
      async () => {
        const source = await seed(
          "conflicting-attempts",
          "conflicting-attempts",
        );
        const ids = [randomUUID(), randomUUID()];
        const results = await Promise.all(
          ids.map((id) => recoverRefresh(source, id)),
        );
        const winner = results.findIndex((r) => r.statusCode === 200);
        assert.ok(winner >= 0);
        assert.equal(
          (await recoverRefresh(source, ids[1 - winner])).statusCode,
          401,
        );
      },
    );
    for (const kind of ["browser", "home_screen"]) {
      for (const authority of [
        "provider_membership_generation",
        "provider_membership_inactive",
        "provider_access_generation",
        "site_membership_generation",
        "site_membership_inactive",
      ]) {
        await t.test(`${kind}: ${authority} invalidates recovery`, async () => {
          const id = `authority-${kind}-${authority}`;
          const isProvider = authority.startsWith("provider");
          const source = await seed(id, id, isProvider);
          const membership = await get(
            "PROVIDER#provider",
            "PROVIDER_MANAGER#member",
          );
          if (!isProvider) {
            const device = await get(`SITE#${id}`, `DEVICE#${id}`);
            await put({
              ...device,
              accessLevel: "manager",
              membershipId: "local-member",
              membershipGeneration: 1,
            });
            await put({
              pk: `SITE#${id}`,
              sk: "MANAGER_MEMBERSHIP#local-member",
              status: "active",
              generation: 1,
            });
            const subject = { ...source, accessLevel: "manager" };
            const [access, refreshToken] = await Promise.all([
              mintAccessToken(subject),
              mintRefreshToken(subject),
            ]);
            source.token = access.token;
            source.refreshToken = refreshToken.token;
            await put({
              ...device,
              accessLevel: "manager",
              membershipId: "local-member",
              membershipGeneration: 1,
              refreshJti: refreshToken.jti,
            });
          }
          const session = kind === "browser" ? source : await handoff(source);
          const attempt = randomUUID();
          responseBody(await recoverRefresh(session, attempt));
          if (authority === "provider_access_generation") {
            const site = await get(`SITE#${id}`, "#META");
            await put({ ...site, providerAccessGeneration: 1 });
          } else if (isProvider)
            await put({
              ...membership,
              ...(authority.endsWith("generation")
                ? { generation: 2 }
                : { status: "inactive" }),
            });
          else {
            const member = await get(
              `SITE#${id}`,
              "MANAGER_MEMBERSHIP#local-member",
            );
            await put({
              ...member,
              ...(authority.endsWith("generation")
                ? { generation: 2 }
                : { status: "inactive" }),
            });
          }
          assert.equal(
            (await recoverRefresh(session, attempt)).statusCode,
            401,
          );
          if (isProvider) await put(membership); // synthetic fixture reset only
        });
      }
    }
    await t.test(
      "REAL BROWSER: reload after server commit recovers from IndexedDB; revocation still wins",
      async (browserTest) => {
        const { spawn } = await import("node:child_process");
        const { chromium } = await import("@playwright/test");
        const probe = createServer();
        await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
        const frontendPort = probe.address().port;
        await new Promise((resolve) => probe.close(resolve));
        const origin = `http://127.0.0.1:${frontendPort}`;
        const vite = spawn(
          process.execPath,
          [
            fileURLToPath(
              new URL("../../node_modules/vite/bin/vite.js", import.meta.url),
            ),
            "--host",
            "127.0.0.1",
            "--port",
            String(frontendPort),
            "--strictPort",
          ],
          {
            cwd: fileURLToPath(new URL("../../frontend", import.meta.url)),
            stdio: "ignore",
          },
        );
        let browser;
        try {
          for (let count = 0; ; count++) {
            try {
              if ((await fetch(origin)).ok) break;
            } catch {}
            if (count > 100)
              throw new Error("Local test Vite server did not start");
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          browser = await chromium.launch();
          for (const scenario of ["reload", "revoked", "storage_failure"]) {
            const revoke = scenario === "revoked";
            await browserTest.test(
              revoke
                ? "revocation during interruption rejects recovery"
                : scenario === "storage_failure"
                  ? "failed IndexedDB save retains the attempt and recovers after reload"
                  : "discarded response + document reload preserves enrollment",
              async () => {
                const id = `browser-lost-${scenario}`;
                const source = await seed(id, id);
                const context = await browser.newContext();
                try {
                  await context.route("**/recovery-test", (route) =>
                    route.fulfill({
                      contentType: "text/html",
                      body: '<!doctype html><html lang="en"><head><title>Refresh recovery test</title></head><body></body></html>',
                    }),
                  );
                  let attempts = 0;
                  let attemptId;
                  let committed;
                  let release;
                  let reached;
                  const holdResponse = new Promise((resolve) => {
                    release = resolve;
                  });
                  let deadline;
                  const serverCommitted = new Promise((resolve, reject) => {
                    reached = resolve;
                    deadline = setTimeout(
                      () =>
                        reject(
                          new Error("Refresh did not reach its commit barrier"),
                        ),
                      10000,
                    );
                  }).finally(() => clearTimeout(deadline));
                  await context.route(
                    "**/v1/devices/token:refresh",
                    async (route) => {
                      const body = route.request().postDataJSON();
                      attempts++;
                      assert.equal(body.refreshToken, source.refreshToken);
                      if (!attemptId) attemptId = body.attemptId;
                      assert.equal(body.attemptId, attemptId);
                      assert.match(attemptId, /^[0-9a-f-]{36}$/);
                      const result = await refreshDeviceToken({
                        body: JSON.stringify(body),
                        requestContext: {},
                      });
                      if (attempts === 1) {
                        committed = responseBody(result);
                        reached();
                        if (scenario === "storage_failure") {
                          await route.fulfill({
                            status: result.statusCode,
                            contentType: "application/json",
                            body: result.body,
                          });
                          return;
                        }
                        await holdResponse; // discard the committed response by reloading the document
                        try {
                          await route.abort("failed");
                        } catch {}
                      } else
                        await route.fulfill({
                          status: result.statusCode,
                          contentType: "application/json",
                          body: result.body,
                        });
                    },
                  );
                  await context.route("**/v1/checks*", async (route) => {
                    const auth = route
                      .request()
                      .headers()
                      .authorization?.replace(/^Bearer /, "");
                    const valid = await allowed(auth);
                    await route.fulfill({
                      status: valid ? 200 : 401,
                      json: valid ? { checks: [] } : { error: "unauthorized" },
                    });
                  });
                  const page = await context.newPage();
                  await page.goto(`${origin}/recovery-test`);
                  await page.evaluate(
                    async ({ session, failStorage }) => {
                      const dbUrl = "/src/db.js";
                      const { setSite } = await import(dbUrl);
                      await setSite("Synthetic test site", {
                        ...session,
                        siteId: session.siteId,
                        tokenExpiresAt: "2000-01-01T00:00:00Z",
                      });
                      const apiUrl = "/src/services/api.js";
                      const api = await import(apiUrl);
                      if (failStorage) {
                        const put = IDBObjectStore.prototype.put;
                        IDBObjectStore.prototype.put = function (value, key) {
                          if (
                            this.name === "site" &&
                            value?.token &&
                            value.token !== session.token
                          )
                            throw new DOMException(
                              "Injected storage failure",
                              "QuotaExceededError",
                            );
                          return key === undefined
                            ? put.call(this, value)
                            : put.call(this, value, key);
                        };
                      }
                      window.refreshTestResult = api.listChecks().then(
                        () => ({ ok: true }),
                        (error) => ({ ok: false, name: error.name }),
                      );
                    },
                    {
                      session: source,
                      failStorage: scenario === "storage_failure",
                    },
                  );
                  await serverCommitted;
                  if (scenario === "storage_failure") {
                    const failed = await page.evaluate(
                      () => window.refreshTestResult,
                    );
                    assert.equal(failed.name, "QuotaExceededError");
                  }
                  // Prove the browser committed its intent before the server rotated.
                  const before = await page.evaluate(async () => {
                    const url = "/src/db.js";
                    return (await import(url)).getSite();
                  });
                  assert.equal(before.refreshToken, source.refreshToken);
                  assert.equal(before.refreshAttempt.id, attemptId);
                  if (revoke)
                    responseBody(
                      await revokeGeneralBinding({
                        body: "{}",
                        pathParameters: { bindingId: id },
                        requestContext: {
                          authorizer: {
                            jwt: {
                              claims: {
                                "custom:siteId": id,
                                sub: "manager",
                                accessLevel: "manager",
                              },
                            },
                          },
                        },
                      }),
                    );
                  await page.reload({ waitUntil: "domcontentloaded" });
                  release();
                  const result = await page.evaluate(async () => {
                    const apiUrl = "/src/services/api.js";
                    try {
                      await (await import(apiUrl)).listChecks();
                      return { ok: true };
                    } catch (error) {
                      return { ok: false, name: error.name };
                    }
                  });
                  assert.equal(attempts, 2);
                  assert.equal(result.ok, !revoke);
                  if (revoke) assert.equal(result.name, "ReauthRequiredError");
                  const stored = await page.evaluate(async () => {
                    const url = "/src/db.js";
                    return (await import(url)).getSite();
                  });
                  if (!revoke) {
                    assert.equal(stored.token, committed.token);
                    assert.equal(stored.refreshToken, committed.refreshToken);
                    assert.equal(stored.refreshAttempt, undefined);
                    assert.equal(await allowed(stored.token), true);
                    // A late response cannot overwrite a new enrollment at the same Site.
                    const switched = await page.evaluate(
                      async ({ older, original }) => {
                        const url = "/src/db.js";
                        const db = await import(url);
                        await db.setSite("Replacement", {
                          ...original,
                          deviceId: "replacement-device",
                          refreshToken: "replacement-refresh",
                        });
                        const saved = await db.updateSiteSession(
                          older,
                          original.siteId,
                          original.refreshToken,
                        );
                        const current = await db.getSite();
                        return {
                          saved,
                          deviceId: current.deviceId,
                          attempt: current.refreshAttempt,
                        };
                      },
                      { older: committed, original: source },
                    );
                    assert.equal(switched.saved, null);
                    assert.equal(switched.deviceId, "replacement-device");
                    assert.equal(switched.attempt, undefined);
                    const sibling = await context.newPage();
                    await sibling.goto(`${origin}/recovery-test`);
                    const prepare = (tab) =>
                      tab.evaluate(async (siteId) => {
                        const url = "/src/db.js";
                        return (await import(url)).prepareRefreshAttempt(
                          siteId,
                          "replacement-refresh",
                        );
                      }, source.siteId);
                    const shared = await Promise.all([
                      prepare(page),
                      prepare(sibling),
                    ]);
                    assert.equal(shared[0], shared[1]); // IndexedDB serializes even without Web Locks
                    assert.match(shared[0], /^[0-9a-f-]{36}$/);
                    const local = await page.evaluate(async (siteId) => {
                      const url = "/src/db.js";
                      const db = await import(url);
                      await db.saveSiteSettings(
                        { refreshAttempt: { id: "untrusted-setting" } },
                        siteId,
                      );
                      const before = await db.getSite();
                      await db.clearSiteSession();
                      return {
                        attempt: before.refreshAttempt.id,
                        after: await db.getSite(),
                        retry: await db.prepareRefreshAttempt(
                          siteId,
                          "replacement-refresh",
                        ),
                      };
                    }, source.siteId);
                    assert.equal(local.attempt, shared[0]);
                    assert.equal(local.after, undefined);
                    assert.equal(local.retry, null);
                  } else assert.equal(stored.refreshToken, source.refreshToken);
                } finally {
                  await context.close();
                }
              },
            );
          }
        } finally {
          if (browser) await browser.close();
          vite.kill("SIGTERM");
        }
      },
    );
    await t.test(
      "physical-device-wide revocation disables browser and Home Screen recovery receipts",
      async () => {
        const id = "physical-recovery";
        const source = await seed(id, id);
        const installed = await handoff(source);
        const physicalId = "isolated-recovery-physical";
        await put({
          pk: `PHYSICAL_DEVICE#${physicalId}`,
          sk: "#META",
          physicalDeviceId: physicalId,
          label: "Recovery test phone",
          status: "active",
        });
        for (const prefix of ["DEVICE", "DEVICE_BINDING"]) {
          const row = await get(`SITE#${id}`, `${prefix}#${id}`);
          await put({ ...row, physicalDeviceId: physicalId });
        }
        const pointer = await get("PHYSICAL_DEVICE#physical", `BINDING#${id}`);
        await put({
          ...pointer,
          pk: `PHYSICAL_DEVICE#${physicalId}`,
          physicalDeviceId: physicalId,
        });
        const attempts = [randomUUID(), randomUUID()];
        const inputs = [source, installed];
        const sessions = (
          await Promise.all(
            inputs.map((session, i) => recoverRefresh(session, attempts[i])),
          )
        ).map(responseBody);
        const { revokePhysicalDeviceEverywhere } = await import(
          "../src/handlers/admin-device-revocation.js"
        );
        responseBody(
          await revokePhysicalDeviceEverywhere(
            supervisor(
              { physicalDeviceId: physicalId },
              { confirmation: "Recovery test phone" },
            ),
          ),
        );
        for (let i = 0; i < inputs.length; i++) {
          assert.equal(
            (await recoverRefresh(inputs[i], attempts[i])).statusCode,
            401,
          );
          assert.equal(
            (await recoverRefresh(sessions[i], randomUUID())).statusCode,
            401,
          );
        }
      },
    );
    await t.test(
      "registration cannot reuse a generation after concurrent refresh",
      async () => {
        const id = "registration-refresh-cas";
        const source = await seed(id, id);
        await put({
          pk: "SITE_CODE#987654",
          sk: "#META",
          active: true,
          siteId: id,
          siteName: "Synthetic site",
          accessLevel: "general",
        });
        const originalSend = ddb.send.bind(ddb);
        let release;
        let reached;
        const barrier = new Promise((resolve) => {
          reached = resolve;
        });
        const held = new Promise((resolve) => {
          release = resolve;
        });
        ddb.send = async (command) => {
          if (
            command.input.TransactItems?.some(
              (item) => item.Put?.Item?.type === "device",
            )
          ) {
            reached();
            await held;
          }
          return originalSend(command);
        };
        try {
          const registering = registerDevice({
            body: JSON.stringify({ code: "987654", deviceId: id }),
          });
          await barrier;
          const rotated = responseBody(
            await recoverRefresh(source, randomUUID()),
          );
          release();
          assert.equal((await registering).statusCode, 409);
          assert.equal(await allowed(rotated.token), true);
        } finally {
          release();
          ddb.send = originalSend;
        }
      },
    );
    for (const kind of ["browser", "home_screen"]) {
      for (const timing of ["before_read", "before_write"]) {
        await t.test(
          `${kind}: cached sign-out cannot end re-registration ${timing}`,
          async () => {
            const id = `replace-${kind}-${timing}`;
            const source = await seed(id, id);
            const session = kind === "browser" ? source : await handoff(source);
            const logout = await eventFor(session.token, { endSession: true });
            await put({
              pk: "SITE_CODE#987654",
              sk: "#META",
              active: true,
              siteId: id,
              siteName: "Synthetic site",
              accessLevel: "general",
            });
            const replace = async () => {
              const result = await registerDevice({
                body: JSON.stringify({ code: "987654", deviceId: id }),
              });
              assert.equal(result.statusCode, 201);
              return JSON.parse(result.body);
            };
            let replacement;
            if (timing === "before_read") {
              replacement = await replace();
              responseBody(await retireSessionHandoff(logout));
            } else {
              const originalSend = ddb.send.bind(ddb);
              let release;
              let reached;
              const barrier = new Promise((resolve) => {
                reached = resolve;
              });
              const held = new Promise((resolve) => {
                release = resolve;
              });
              ddb.send = async (command) => {
                if (
                  command.input.TransactItems?.some(
                    (item) =>
                      item.Put?.Item?.eventType === "device_session_signed_out",
                  )
                ) {
                  reached();
                  await held;
                }
                return originalSend(command);
              };
              try {
                const ending = retireSessionHandoff(logout);
                await barrier;
                replacement = await replace();
                release();
                responseBody(await ending);
              } finally {
                release();
                ddb.send = originalSend;
              }
            }
            assert.equal(await allowed(replacement.token), true);
            assert.equal(await allowed(session.token), false);
            const issued = responseBody(
              await issueSessionHandoff(await eventFor(replacement.token)),
            );
            const installed = responseBody(
              await redeemSessionHandoff({
                body: JSON.stringify({
                  grantId: issued.grantId,
                  token: issued.token,
                }),
                requestContext: {},
              }),
            );
            // Replaying the cached verdict again must preserve both new contexts.
            responseBody(await retireSessionHandoff(logout));
            assert.equal(await allowed(replacement.token), true);
            assert.equal(await allowed(installed.token), true);
            responseBody(await recoverRefresh(replacement, randomUUID()));
            responseBody(await recoverRefresh(installed, randomUUID()));
          },
        );
      }
      await t.test(
        `${kind}: stale logout cannot end a reactivated session`,
        async () => {
          const id = `reactivated-${kind}`;
          const source = await seed(id, id);
          const target = await seed(`${id}-target`, `${id}-target`);
          const session = kind === "browser" ? source : await handoff(source);
          const logout = await eventFor(session.token, { endSession: true });
          const elsewhere = responseBody(
            await selectDeviceBinding(
              await eventFor(session.token, {
                bindingId: target.deviceId,
              }),
            ),
          );
          responseBody(await retireSessionHandoff(logout));
          const returning = await selectDeviceBinding(
            await eventFor(elsewhere.token, { bindingId: source.deviceId }),
          );
          // Signed-out Home Screen slots cannot be revived by Site switching;
          // a fresh install gets a different sid under the same device.
          if (kind === "home_screen") assert.equal(returning.statusCode, 409);
          const reactivated =
            kind === "home_screen"
              ? await handoff(source)
              : responseBody(returning);
          const rotated = responseBody(
            await recoverRefresh(reactivated, randomUUID()),
          );
          responseBody(await retireSessionHandoff(logout));
          assert.equal(await allowed(rotated.token), true);
          const currentLogout = await eventFor(rotated.token, {
            endSession: true,
          });
          const latest = responseBody(
            await recoverRefresh(rotated, randomUUID()),
          );
          // Its own pre-refresh token still ends this incarnation after rotation.
          responseBody(await retireSessionHandoff(currentLogout));
          assert.equal(await allowed(latest.token), false);
        },
      );
      await t.test(
        `${kind}: refresh cannot commit after sign-out wins`,
        async () => {
          const id = `refresh-after-logout-${kind}`;
          const source = await seed(id, id);
          const row = await get(`SITE#${id}`, `DEVICE#${id}`);
          await put({ ...row, sessionStartGeneration: 1 });
          const session = kind === "browser" ? source : await handoff(source);
          const logout = await eventFor(session.token, { endSession: true });
          const attempt = randomUUID();
          const originalSend = ddb.send.bind(ddb);
          let release;
          let reached;
          const barrier = new Promise((resolve) => {
            reached = resolve;
          });
          const held = new Promise((resolve) => {
            release = resolve;
          });
          ddb.send = async (command) => {
            if (
              command.input.TransactItems?.some(
                (item) =>
                  item.Update?.ExpressionAttributeValues?.[":receipt"] ||
                  item.Update?.ExpressionAttributeValues?.[":session"]
                    ?.refreshRecovery,
              )
            ) {
              reached();
              await held;
            }
            return originalSend(command);
          };
          try {
            const refreshing = recoverRefresh(session, attempt);
            await barrier;
            responseBody(await retireSessionHandoff(logout));
            release();
            assert.equal((await refreshing).statusCode, 401);
            assert.equal(await allowed(session.token), false);
            assert.equal(
              (await recoverRefresh(session, attempt)).statusCode,
              401,
            );
          } finally {
            release();
            ddb.send = originalSend;
          }
        },
      );
      await t.test(
        `${kind}: sign-out wins after refresh commits between its read and write`,
        async () => {
          const id = `logout-race-${kind}`;
          const source = await seed(id, id);
          const target = await seed(`${id}-target`, `${id}-target`);
          const session = kind === "browser" ? source : await handoff(source);
          const logout = await eventFor(session.token, { endSession: true });
          const cachedSwitch = await eventFor(session.token, {
            bindingId: target.deviceId,
          });
          const originalSend = ddb.send.bind(ddb);
          let release;
          let reached;
          const barrier = new Promise((resolve) => {
            reached = resolve;
          });
          const held = new Promise((resolve) => {
            release = resolve;
          });
          ddb.send = async (command) => {
            if (
              command.input.TransactItems?.some(
                (item) =>
                  item.Put?.Item?.eventType === "device_session_signed_out",
              )
            ) {
              reached();
              await held;
            }
            return originalSend(command);
          };
          try {
            const ending = retireSessionHandoff(logout);
            await barrier;
            const attempt = randomUUID();
            const rotated = responseBody(
              await recoverRefresh(session, attempt),
            );
            release();
            responseBody(await ending);
            assert.equal(await allowed(rotated.token), false);
            assert.equal(
              (await recoverRefresh(session, attempt)).statusCode,
              401,
            );
            assert.equal(
              (await selectDeviceBinding(cachedSwitch)).statusCode,
              401,
            );
            assert.equal(await allowed(target.token), true);
          } finally {
            release();
            ddb.send = originalSend;
          }
        },
      );
      await t.test(
        `${kind}: a cached old generation cannot mint a Home Screen grant`,
        async () => {
          const id = `cached-grant-${kind}`;
          const source = await seed(id, id);
          const session = kind === "browser" ? source : await handoff(source);
          const cached = await eventFor(session.token);
          responseBody(await recoverRefresh(session, randomUUID()));
          assert.equal((await issueSessionHandoff(cached)).statusCode, 401);
        },
      );
      await t.test(
        `${kind}: source Site revocation blocks switching despite cached authorization`,
        async () => {
          const id = `cached-switch-${kind}`;
          const source = await seed(id, id);
          const target = await seed(`${id}-target`, `${id}-target`);
          const session = kind === "browser" ? source : await handoff(source);
          const cached = await eventFor(session.token, {
            bindingId: target.deviceId,
          });
          const site = await get(`SITE#${id}`, "#META");
          await put({ ...site, siteCredentialGeneration: 1 });
          assert.equal((await selectDeviceBinding(cached)).statusCode, 401);
          assert.equal(await allowed(target.token), true);
        },
      );
      await t.test(
        `${kind}: Site selection cannot commit after its source signs out`,
        async () => {
          const id = `select-logout-race-${kind}`;
          const source = await seed(id, id);
          const target = await seed(`${id}-target`, `${id}-target`);
          const session = kind === "browser" ? source : await handoff(source);
          const request = await eventFor(session.token, {
            bindingId: target.deviceId,
          });
          const logout = await eventFor(session.token, { endSession: true });
          const originalSend = ddb.send.bind(ddb);
          let release;
          let reached;
          const barrier = new Promise((resolve) => {
            reached = resolve;
          });
          const held = new Promise((resolve) => {
            release = resolve;
          });
          ddb.send = async (command) => {
            if (
              command.input.TransactItems?.some(
                (item) =>
                  item.Put?.Item?.eventType === "device_binding_selected",
              )
            ) {
              reached();
              await held;
            }
            return originalSend(command);
          };
          try {
            const selecting = selectDeviceBinding(request);
            await barrier;
            responseBody(await retireSessionHandoff(logout));
            release();
            assert.equal((await selecting).statusCode, 409);
            assert.equal(await allowed(target.token), true);
          } finally {
            release();
            ddb.send = originalSend;
          }
        },
      );
    }
    let home;
    await t.test(
      "handoff creates two labeled sessions under one managed device",
      async () => {
        home = await handoff(browser);
        const listing = responseBody(
          await listGeneralBindings(await eventFor(browser.token)),
        );
        assert.equal(listing.bindings.length, 1);
        assert.equal(listing.bindings[0].label, "Bob's phone");
        assert.deepEqual(
          listing.bindings[0].sessions.map((s) => s.kind),
          ["browser", "home_screen"],
        );
        assert.ok(!JSON.stringify(listing).includes("refreshJti"));
        const device = await get("SITE#a", "DEVICE#binding-a");
        assert.equal(device.tokenGeneration, 1);
        assert.equal(
          device.refreshJti,
          (await verifyDeviceToken(browser.refreshToken)).jti,
        );
      },
    );
    await t.test(
      "concurrent refreshes in different contexts keep both sessions valid",
      async () => {
        [browser, home] = await Promise.all([refresh(browser), refresh(home)]);
        assert.equal(await allowed(browser.token), true);
        assert.equal(await allowed(home.token), true);
        assert.equal(
          (await get("SITE#a", "DEVICE#binding-a")).tokenGeneration,
          browser.tokenGeneration,
        );
      },
    );
    await t.test(
      "replaying one context refresh cannot rotate it twice",
      async () => {
        const attempts = await Promise.all(
          [1, 2].map(() =>
            refreshDeviceToken({
              body: JSON.stringify({ refreshToken: home.refreshToken }),
              requestContext: {},
            }),
          ),
        );
        assert.deepEqual(attempts.map((r) => r.statusCode).sort(), [200, 401]);
        home = responseBody(attempts.find((r) => r.statusCode === 200));
        assert.equal(await allowed(browser.token), true);
      },
    );
    await t.test(
      "Home Screen site switching does not rotate the browser's target binding",
      async () => {
        const secondSite = responseBody(
          await selectDeviceBinding(
            await eventFor(home.token, { bindingId: "binding-b" }),
          ),
        );
        assert.equal(
          (await verifyDeviceToken(secondSite.token)).sid,
          (await verifyDeviceToken(home.token)).sid,
        );
        assert.equal(await allowed(secondSite.token), true);
        assert.equal(await allowed(browserB.token), true);
        home = responseBody(
          await selectDeviceBinding(
            await eventFor(secondSite.token, { bindingId: "binding-a" }),
          ),
        );
        assert.equal(await allowed(home.token), true);
        assert.equal(await allowed(browser.token), true);
      },
    );
    await t.test(
      "signing out of Home Screen preserves the browser",
      async () => {
        responseBody(
          await retireSessionHandoff(
            await eventFor(home.token, { endSession: true }),
          ),
        );
        assert.equal(await allowed(home.token), false);
        assert.equal(
          (
            await refreshDeviceToken({
              body: JSON.stringify({ refreshToken: home.refreshToken }),
              requestContext: {},
            })
          ).statusCode,
          401,
        );
        assert.equal(await allowed(browser.token), true);
        home = await handoff(browser);
      },
    );
    await t.test(
      "membership and Site generations deny both contexts",
      async () => {
        const membership = await get(
          "PROVIDER#provider",
          "PROVIDER_MANAGER#member",
        );
        await put({ ...membership, generation: 2 });
        assert.equal(await allowed(browser.token), false);
        assert.equal(await allowed(home.token), false);
        for (const session of [browser, home])
          assert.equal(
            (
              await refreshDeviceToken({
                body: JSON.stringify({ refreshToken: session.refreshToken }),
                requestContext: {},
              })
            ).statusCode,
            401,
          );
        // Restore only synthetic fixtures to isolate the next authority check.
        await put(membership);
        const site = await get("SITE#a", "#META");
        await put({ ...site, siteCredentialGeneration: 1 });
        assert.equal(await allowed(browser.token), false);
        assert.equal(await allowed(home.token), false);
        for (const session of [browser, home])
          assert.equal(
            (
              await refreshDeviceToken({
                body: JSON.stringify({ refreshToken: session.refreshToken }),
                requestContext: {},
              })
            ).statusCode,
            401,
          );
        await put(site);
      },
    );
    await t.test(
      "provider enrollment revocation disables both contexts and refresh paths",
      async () => {
        const interrupted = [browser, home];
        const attemptIds = [randomUUID(), randomUUID()];
        [browser, home] = (
          await Promise.all(
            interrupted.map((session, i) =>
              recoverRefresh(session, attemptIds[i]),
            ),
          )
        ).map(responseBody);

        responseBody(
          await revokeProviderManagerEnrollment(
            supervisor({ providerId: "provider", enrollmentId: "enrollment" }),
          ),
        );
        for (let i = 0; i < interrupted.length; i++)
          assert.equal(
            (await recoverRefresh(interrupted[i], attemptIds[i])).statusCode,
            401,
          );
        assert.equal(await allowed(browser.token), false);
        assert.equal(await allowed(home.token), false);
        for (const session of [browser, home])
          assert.equal(
            (
              await refreshDeviceToken({
                body: JSON.stringify({ refreshToken: session.refreshToken }),
                requestContext: {},
              })
            ).statusCode,
            401,
          );
      },
    );
    await t.test(
      "a Site Manager revoking one team device disables browser and Home Screen",
      async () => {
        const teamBrowser = await seed("team", "team-binding");
        const teamHome = await handoff(teamBrowser);
        const request = {
          body: "{}",
          pathParameters: { bindingId: "team-binding" },
          requestContext: {
            authorizer: {
              jwt: {
                claims: {
                  "custom:siteId": "team",
                  sub: "manager",
                  accessLevel: "manager",
                },
              },
            },
          },
        };
        responseBody(await revokeGeneralBinding(request));
        assert.equal(await allowed(teamBrowser.token), false);
        assert.equal(await allowed(teamHome.token), false);
      },
    );
    await t.test(
      "browser sign-out preserves an existing Home Screen session",
      async () => {
        const source = await seed("logout", "logout-binding");
        const installed = await handoff(source);
        responseBody(
          await retireSessionHandoff(
            await eventFor(source.token, { endSession: true }),
          ),
        );
        assert.equal(await allowed(source.token), false);
        assert.equal(await allowed(installed.token), true);
        const rotated = await refresh(installed);
        assert.equal(await allowed(rotated.token), true);
      },
    );
    await t.test(
      "a late mint cannot restore a grant after browser sign-out",
      async () => {
        const source = await seed("late", "late-binding");
        const request = await eventFor(source.token);
        const send = ddb.send.bind(ddb);
        let release;
        let reached;
        const waiting = new Promise((resolve) => {
          reached = resolve;
        });
        ddb.send = async (command) => {
          if (
            command.input.TransactItems?.some(
              (item) => item.Put?.Item?.type === "sessionHandoffGrant",
            )
          ) {
            reached();
            await new Promise((resolve) => {
              release = resolve;
            });
          }
          return send(command);
        };
        try {
          const mint = issueSessionHandoff(request);
          await waiting;
          responseBody(
            await retireSessionHandoff(
              await eventFor(source.token, { endSession: true }),
            ),
          );
          release();
          assert.equal((await mint).statusCode, 401);
          assert.equal(
            (await get("SITE#late", "DEVICE#late-binding")).handoffGrantId,
            undefined,
          );
          assert.equal((await issueSessionHandoff(request)).statusCode, 401);
        } finally {
          ddb.send = send;
        }
      },
    );
    await t.test(
      "no extra managed device or enrollment records were created by handoff",
      async () => {
        const rows = await ddb.send(
          new QueryCommand({
            TableName: table,
            KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues: {
              ":pk": "SITE#a",
              ":prefix": "DEVICE_BINDING#",
            },
          }),
        );
        assert.equal(rows.Items.length, 1);
        const enrollments = await ddb.send(
          new QueryCommand({
            TableName: table,
            KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues: {
              ":pk": "PROVIDER#provider",
              ":prefix": "PROVIDER_MANAGER_ENROLLMENT#",
            },
          }),
        );
        assert.equal(enrollments.Items.length, 1);
      },
    );
  } finally {
    ddb.destroy();
    client.destroy();
    await DynamoDbLocal.stop(port);
  }
});
