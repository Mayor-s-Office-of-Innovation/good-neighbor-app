// Synthetic records and an isolated in-memory DynamoDB. Never reads production.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import DynamoDbLocal from "dynamodb-local";
import {
  DynamoDBClient,
  CreateTableCommand,
  ListTablesCommand,
} from "@aws-sdk/client-dynamodb";
import {
  ScanCommand,
  QueryCommand,
  PutCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
Object.assign(process.env, {
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "localtest",
  AWS_SECRET_ACCESS_KEY: "synthetic-test-only",
  AWS_SESSION_TOKEN: "",
  AWS_ENDPOINT_URL_DYNAMODB: `http://127.0.0.1:${port}`,
  DYNAMO_TABLE: "site-import-managers-test",
  SETUP_CODE_VERIFIER_SECRET: "synthetic-test-verifier",
});
DynamoDbLocal.configureInstaller({
  installPath: fileURLToPath(
    new URL("../.local/dynamodb-local", import.meta.url),
  ),
});
const originalFetch = globalThis.fetch;
let noAddressMatch = false;
globalThis.fetch = async (url) => {
  assert.ok(String(url).startsWith("https://geocoding.geo.census.gov/"));
  return Response.json({
    result: {
      addressMatches: noAddressMatch
        ? []
        : [
            {
              coordinates: { x: -122.42, y: 37.78 },
              matchedAddress: "SYNTHETIC ADDRESS",
            },
          ],
    },
  });
};
const header = (
  await readFile(
    new URL("../fixtures/synthetic/site-admin-demo.csv", import.meta.url),
    "utf8",
  )
).split("\n")[0];
function values(site, manager) {
  return [
    "Synthetic Provider",
    "Synthetic Program",
    site,
    `${site} San Francisco CA 94102`,
    "Shelter",
    "Department of Public Health (DPH)",
    "Synthetic",
    "SiteManager",
    "415-555-0100",
    "",
    "site-manager@example.test",
    "Synthetic",
    `Manager${manager}`,
    "415-555-0101",
    "",
    "Department of Public Health (DPH)",
    `manager${manager}@example.test`,
    "Synthetic",
    "ProviderManager",
    "415-555-0102",
    "",
    "provider-manager@example.test",
  ];
}
const csv = (rows) =>
  header +
  "\n" +
  rows
    .map((row) => row.map((value) => JSON.stringify(value)).join(","))
    .join("\n");
const event = (body, importId) => ({
  body: JSON.stringify(body),
  pathParameters: { importId },
  requestContext: {
    authorizer: {
      jwt: {
        claims: {
          "cognito:groups": "compliance-supervisor",
          sub: "synthetic-admin",
        },
      },
    },
  },
});

await test("Program manager imports preserve unrelated records using real transactions", async (t) => {
  await DynamoDbLocal.launch(port, null, ["-sharedDb"]);
  const client = new DynamoDBClient({});
  const { ddb } = await import("../src/db.js");
  const { previewSiteImport, applySiteImport } = await import(
    "../src/handlers/admin-site-imports.js"
  );
  const TableName = process.env.DYNAMO_TABLE;
  const send = ddb.send.bind(ddb);
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
        TableName,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
      }),
    );
    const snapshot = async () => {
      const { Items } = await send(
        new ScanCommand({ TableName, ConsistentRead: true }),
      );
      return new Map(
        Items.filter((item) => !item.pk.startsWith("SITE_IMPORT")).map(
          (item) => [`${item.pk}|${item.sk}`, item],
        ),
      );
    };
    let failNextTransaction = "";
    let observe = false;
    const mutations = [];
    ddb.send = async (command) => {
      if (!(command instanceof TransactWriteCommand)) return send(command);
      if (failNextTransaction) {
        const name = failNextTransaction;
        failNextTransaction = "";
        throw Object.assign(new Error("synthetic transaction error"), { name });
      }
      const before = observe ? await snapshot() : null;
      const result = await send(command);
      if (before) {
        const after = await snapshot();
        mutations.push(
          [...after]
            .filter(([key, item]) => !isDeepStrictEqual(before.get(key), item))
            .map(([, item]) => item),
        );
      }
      return result;
    };
    const call = async (handler, body, importId) => {
      const response = await handler(event(body, importId), {}, () => {});
      assert.ok(
        [200, 201, 202].includes(response.statusCode),
        String(response.body),
      );
      return JSON.parse(response.body);
    };
    const preview = (rows) =>
      call(previewSiteImport, { fileName: "synthetic.csv", csv: csv(rows) });
    const apply = (p) =>
      call(
        applySiteImport,
        {
          previewVersion: p.previewVersion,
          idempotencyKey: `apply-${p.importId}`,
        },
        p.importId,
      );
    const ledger = async (p) =>
      (
        await send(
          new QueryCommand({
            TableName,
            KeyConditionExpression: "pk = :pk AND begins_with(sk, :row)",
            ExpressionAttributeValues: {
              ":pk": `SITE_IMPORT#${p.importId}`,
              ":row": "ROW#",
            },
            ConsistentRead: true,
          }),
        )
      ).Items;
    await t.test(
      "two managers on a new site; only manager and assignment change on the second row",
      async () => {
        const p = await preview([
          values("1 Synthetic St", 1),
          values("1 Synthetic St", 2),
        ]);
        const planned = await ledger(p);
        assert.equal(planned[1].plan.mode, "program-manager-only");
        assert.deepEqual(planned[1].plan.dependsOnRows, [2]);
        assert.equal(
          planned[1].plan.site.expectedOversight.managingCityDepartmentId,
          "dph",
        );
        observe = true;
        const result = await apply(p);
        observe = false;
        assert.equal(result.outcomes.applied, 2);
        assert.deepEqual(
          mutations
            .at(-1)
            .map((item) => item.type)
            .sort(),
          ["cityProgramManager", "siteComplianceManagerAssignment"],
        );
      },
    );
    await t.test(
      "reimporting identical rows is an application-data no-op",
      async () => {
        const before = await snapshot();
        const result = await apply(
          await preview([
            values("1 Synthetic St", 1),
            values("1 Synthetic St", 2),
          ]),
        );
        assert.equal(result.outcomes.applied, 2);
        assert.deepEqual(await snapshot(), before);
      },
    );
    await t.test(
      "fresh import adds a manager to an existing site without modifying it",
      async () => {
        await apply(await preview([values("2 Synthetic St", 3)]));
        const p = await preview([values("2 Synthetic St", 4)]);
        assert.equal((await ledger(p))[0].plan.mode, "program-manager-only");
        observe = true;
        const result = await apply(p);
        observe = false;
        assert.equal(result.outcomes.applied, 1);
        assert.deepEqual(
          mutations
            .at(-1)
            .map((item) => item.type)
            .sort(),
          ["cityProgramManager", "siteComplianceManagerAssignment"],
        );
      },
    );
    await t.test(
      "genuine external changes cause a conflict without partial assignment writes",
      async () => {
        await apply(await preview([values("3 Synthetic St", 5)]));
        const p = await preview([values("3 Synthetic St", 6)]);
        const row = (await ledger(p))[0];
        const item = (await snapshot()).get(`SITE#${row.plan.site.id}|#META`);
        await send(
          new PutCommand({
            TableName,
            Item: { ...item, name: "Changed after preview" },
          }),
        );
        const before = await snapshot();
        const result = await apply(p);
        assert.equal(result.outcomes.skipped_conflict, 1);
        assert.deepEqual(await snapshot(), before);
      },
    );
    await t.test(
      "dependent rows wait for a retryable predecessor and then import",
      async () => {
        const p = await preview([
          values("4 Synthetic St", 7),
          values("4 Synthetic St", 8),
        ]);
        failNextTransaction = "InternalServerError";
        const first = await apply(p);
        assert.equal(first.status, "applying");
        const waiting = await ledger(p);
        assert.equal(waiting[0].outcome, "retryable_failed");
        assert.equal(waiting[1].outcome, undefined);
        const result = await apply(p);
        assert.equal(result.status, "complete");
        assert.equal(result.outcomes.applied, 2);
      },
    );
    await t.test(
      "terminal predecessor failure prevents orphan manager assignments",
      async () => {
        const p = await preview([
          values("5 Synthetic St", 9),
          values("5 Synthetic St", 10),
        ]);
        const before = await snapshot();
        noAddressMatch = true;
        const result = await apply(p);
        noAddressMatch = false;
        assert.equal(result.outcomes.failed, 1);
        assert.equal(result.outcomes.skipped_conflict, 1);
        assert.equal(result.rows[1].reasonCode, "import_dependency_failed");
        assert.deepEqual(await snapshot(), before);
      },
    );
    await t.test(
      "conflicting non-manager fields are rejected without changing data",
      async () => {
        const before = await snapshot();
        const changed = values("1 Synthetic St", 1);
        changed[6] = "Different";
        const p = await preview([changed]);
        assert.equal(p.rows[0].reasonCode, "contact_exact_match_conflict");
        assert.deepEqual(await snapshot(), before);
      },
    );
    await t.test(
      "rows adding a Site manager keep the normal path and preserve the primary",
      async () => {
        const first = values("7 Synthetic St", 14);
        const second = [...first];
        second[6] = "Additional";
        second[10] = "additional-site-manager@example.test";
        const third = [...second];
        third[11] = "Another";
        third[12] = "Manager15";
        third[16] = "manager15@example.test";
        const p = await preview([first, second, third]);
        const planned = await ledger(p);
        assert.equal(planned[1].plan.mode, undefined);
        assert.equal(planned[2].plan.mode, "program-manager-only");
        const result = await apply(p);
        assert.equal(result.outcomes.applied, 3);
        const after = await snapshot();
        const site = after.get(`SITE#${planned[0].plan.site.id}|#META`);
        assert.equal(site.primaryContactUserId, planned[0].plan.contact.id);
        const assignments = [...after.values()].filter(
          (item) =>
            item.pk === `SITE#${planned[0].plan.site.id}` &&
            item.type === "siteUserAssignment",
        );
        assert.equal(assignments.length, 2);
      },
    );
    await t.test(
      "removing metadata after preview is an external conflict",
      async () => {
        await apply(await preview([values("8 Synthetic St", 16)]));
        const p = await preview([values("8 Synthetic St", 17)]);
        const row = (await ledger(p))[0];
        const item = {
          ...(await snapshot()).get(`SITE#${row.plan.site.id}|#META`),
        };
        delete item.oversight;
        await send(new PutCommand({ TableName, Item: item }));
        const before = await snapshot();
        const result = await apply(p);
        assert.equal(result.outcomes.skipped_conflict, 1);
        assert.deepEqual(await snapshot(), before);
      },
    );
    await t.test(
      "third distinct manager still conflicts at preview",
      async () => {
        const p = await preview([values("1 Synthetic St", 11)]);
        assert.equal(p.rows[0].reasonCode, "too_many_program_managers");
      },
    );
    await t.test(
      "an independent manager is not skipped after a failed no-op row",
      async () => {
        await apply(await preview([values("9 Synthetic St", 20)]));
        const p = await preview([
          values("9 Synthetic St", 20),
          values("9 Synthetic St", 21),
        ]);
        failNextTransaction = "ValidationException";
        const result = await apply(p);
        assert.equal(result.outcomes.failed, 1);
        assert.equal(result.outcomes.applied, 1);
        assert.equal(result.rows[1].outcome, "applied");
      },
    );
    await t.test(
      "a shared manager directory dependency is retried across different Sites",
      async () => {
        await apply(await preview([values("10 Synthetic St", 22)]));
        const p = await preview([
          values("11 Synthetic St", 23),
          values("10 Synthetic St", 23),
        ]);
        assert.deepEqual((await ledger(p))[1].plan.dependsOnRows, [2]);
        failNextTransaction = "InternalServerError";
        const waiting = await apply(p);
        assert.equal(waiting.status, "applying");
        assert.equal((await ledger(p))[1].outcome, undefined);
        const result = await apply(p);
        assert.equal(result.outcomes.applied, 2);
      },
    );
    await t.test("dependencies survive the 20-row apply boundary", async () => {
      const p = await preview([
        ...Array.from({ length: 20 }, () => values("6 Synthetic St", 12)),
        values("6 Synthetic St", 13),
      ]);
      const first = await apply(p);
      assert.equal(first.status, "applying");
      assert.equal(first.outcomes.applied, 20);
      const result = await apply(p);
      assert.equal(result.outcomes.applied, 21);
    });
  } finally {
    ddb.send = send;
    globalThis.fetch = originalFetch;
    ddb.destroy();
    client.destroy();
    await DynamoDbLocal.stop(port);
  }
});
