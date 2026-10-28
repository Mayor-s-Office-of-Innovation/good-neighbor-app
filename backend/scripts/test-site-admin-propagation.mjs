// Isolated real DynamoDB transactions; never uses the developer's persistent table.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import DynamoDbLocal from "dynamodb-local";
import {
  DynamoDBClient,
  CreateTableCommand,
  ListTablesCommand,
} from "@aws-sdk/client-dynamodb";
import { PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
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
  DYNAMO_TABLE: "site-admin-propagation-test",
  S3_UPLOAD_BUCKET: "synthetic-test-bucket",
  S3_COMPLIANCE_LETTER_BUCKET: "synthetic-compliance-letters",
  SQS_QUEUE_URL: "http://127.0.0.1/test-queue",
});
DynamoDbLocal.configureInstaller({
  installPath: fileURLToPath(
    new URL("../.local/dynamodb-local", import.meta.url),
  ),
});
await test("Site details propagate through canonical local records", async (t) => {
  await DynamoDbLocal.launch(port, null, ["-sharedDb"]);
  const client = new DynamoDBClient({});
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
    const TableName = process.env.DYNAMO_TABLE;
    await client.send(
      new CreateTableCommand({
        TableName,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
          { AttributeName: "gsi1pk", AttributeType: "S" },
          { AttributeName: "gsi1sk", AttributeType: "S" },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: "GSI1",
            KeySchema: [
              { AttributeName: "gsi1pk", KeyType: "HASH" },
              { AttributeName: "gsi1sk", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
      }),
    );
    const put = (Item) => ddb.send(new PutCommand({ TableName, Item }));
    const get = async (pk, sk) =>
      (
        await ddb.send(
          new GetCommand({ TableName, Key: { pk, sk }, ConsistentRead: true }),
        )
      ).Item;
    const { getSiteAdmin, updateSiteAdmin } = await import(
      "../src/handlers/site.js"
    );
    const { updateSite, getAdminSite } = await import(
      "../src/handlers/admin.js"
    );
    const { updatePerson } = await import("../src/handlers/admin-people.js");
    const { personRecord } = await import("../src/lib/people.js");
    const { siteContacts } = await import("../src/lib/site-admin-contacts.js");
    const event = (values, level = "manager", section = "publicContact") => ({
      body: JSON.stringify({ section, values }),
      requestContext: {
        authorizer: {
          jwt: {
            claims: {
              "custom:siteId": "site",
              sub: "synthetic-device",
              accessLevel: level,
            },
          },
        },
      },
    });
    const admin = (body, pathParameters = { siteId: "site" }) => ({
      body: JSON.stringify(body),
      pathParameters,
      requestContext: {
        authorizer: {
          jwt: {
            claims: {
              sub: "synthetic-supervisor",
              "cognito:groups": "compliance-supervisor",
            },
          },
        },
      },
    });
    const result = (response, status = 200) => {
      assert.equal(response.statusCode, status, response.body);
      return JSON.parse(response.body);
    };
    const assignment = {
      pk: "SITE#site",
      sk: "ASSIGNED_USER#manager",
      userId: "manager",
      personId: "person",
      status: "active",
      firstName: "Test",
      lastName: "Manager",
      email: "manager@example.test",
      phone: "415-555-0100",
    };
    const membership = {
      ...assignment,
      sk: "MANAGER_MEMBERSHIP#member",
      membershipId: "member",
      role: "manager",
      generation: 7,
    };
    const person = personRecord(
      assignment,
      "person",
      [assignment, membership].map(({ pk, sk }) => ({ pk, sk })),
    );
    await put({
      pk: "SITE#site",
      sk: "#META",
      siteId: "site",
      name: "Synthetic Site",
      status: "active",
      publicContact: {
        email: "public@example.test",
        phone: "415-555-0101",
        phoneExtension: "2",
      },
      contactPerson: { phone: "415-555-0199" },
      perimeter: "Old perimeter",
    });
    await put(assignment);
    await put(membership);
    await put(person);
    await put({
      pk: "SITE#site",
      sk: "COMPLIANCE_MANAGER#city",
      managerId: "city",
      status: "active",
    });
    const city = {
      pk: "ADMIN_DIRECTORY#PROGRAM_MANAGERS",
      sk: "MANAGER#city@example.test",
      userId: "city",
      name: "Test City Manager",
      email: "city@example.test",
      phone: "415-555-0102",
      departmentName: "Synthetic Department",
      status: "active",
    };
    await put(city);
    await t.test(
      "dashboard public-contact edits reach the app without using contactPerson",
      async () => {
        result(
          await updateSite(
            admin({
              name: "Synthetic Site",
              publicContact: {
                email: "new@example.test",
                phone: "4155550103",
                phoneExtension: "9",
              },
            }),
          ),
        );
        const site = result(await getSiteAdmin(event({}))).site;
        assert.equal(site.publicContact.phone, "415-555-0103");
        assert.equal(site.publicContact.phoneExtension, "9");
        assert.equal(site.contactPerson, undefined);
      },
    );
    await t.test(
      "app public-contact edits persist for the dashboard, preserving unrelated fields",
      async () => {
        result(
          await updateSiteAdmin(
            event({
              email: "app@example.test",
              phone: "4155550104",
              phoneExtension: "8",
            }),
          ),
        );
        const dashboard = result(await getAdminSite(admin({})));
        const site = dashboard.items.find((row) => row.sk === "#META");
        assert.equal(site.publicContact.phone, "415-555-0104");
        assert.equal(site.contactPerson.phone, "415-555-0199");
      },
    );
    await t.test(
      "assigned profiles are deduplicated, sanitized, and resolve current City contacts",
      async () => {
        const site = result(await getSiteAdmin(event({}))).site;
        assert.equal(site.siteManagers.length, 1);
        assert.equal(site.siteManagers[0].personId, "person");
        assert.equal(site.siteManagers[0].sources, undefined);
        assert.equal(site.siteManagers[0].generation, undefined);
        assert.equal(
          site.cityProgramManagers[0].department,
          "Synthetic Department",
        );
        await put({
          ...city,
          phone: "415-555-0105",
          departmentName: "Updated Department",
        });
        assert.equal(
          (await siteContacts("site")).cityProgramManagers[0].phone,
          "415-555-0105",
        );
      },
    );
    await t.test(
      "app changes only the person's phone, atomically updating dashboard projections",
      async () => {
        result(
          await updateSiteAdmin(
            event(
              {
                personId: "person",
                phone: "415-555-0106",
                email: "injected@example.test",
                firstName: "Injected",
              },
              "manager",
              "siteManagerPhone",
            ),
          ),
        );
        assert.equal(
          (await get("PEOPLE", "PERSON#person")).phone,
          "415-555-0106",
        );
        assert.equal(
          (await get("PEOPLE", "PERSON#person")).email,
          person.email,
        );
        assert.equal(
          (await get(assignment.pk, assignment.sk)).phone,
          "415-555-0106",
        );
        assert.equal((await get(membership.pk, membership.sk)).generation, 7);
      },
    );
    await t.test(
      "dashboard person edits reach the app via the canonical profile",
      async () => {
        result(
          await updatePerson(
            admin({ ...person, phone: "415-555-0107" }, { personId: "person" }),
          ),
        );
        assert.equal(
          result(await getSiteAdmin(event({}))).site.siteManagers[0].phone,
          "415-555-0107",
        );
      },
    );
    await t.test(
      "app perimeter changes persist canonical text, attribution, and dashboard audit",
      async () => {
        result(
          await updateSiteAdmin(
            event({ perimeter: " Updated perimeter " }, "manager", "perimeter"),
          ),
        );
        const row = await get("SITE#site", "#META");
        assert.equal(row.perimeter, "Updated perimeter");
        assert.equal(row.perimeterUpdatedBy, "synthetic-device");
        const dashboard = result(await getAdminSite(admin({})));
        assert.ok(
          dashboard.items.some(
            (row) => row.eventType === "perimeter_text_updated",
          ),
        );
      },
    );
    await t.test(
      "general devices, unassigned people, and malformed values cannot write",
      async () => {
        result(
          await updateSiteAdmin(event({ phone: "415-555-0108" }, "general")),
          403,
        );
        result(
          await updateSiteAdmin(
            event(
              { personId: "outsider", phone: "415-555-0108" },
              "manager",
              "siteManagerPhone",
            ),
          ),
          404,
        );
        result(await updateSiteAdmin(event({ phone: "bad" })), 400);
        result(
          await updateSiteAdmin(
            event({ perimeter: "x".repeat(4001) }, "manager", "perimeter"),
          ),
          400,
        );
      },
    );
    await t.test(
      "removing assignment after authorization prevents the person transaction",
      async () => {
        const originalSend = ddb.send.bind(ddb);
        let intercepted = false;
        ddb.send = async (command) => {
          if (
            !intercepted &&
            command.input.TransactItems?.some(
              (write) => write.Put?.Item?.type === "person",
            )
          ) {
            intercepted = true;
            await originalSend(
              new PutCommand({
                TableName,
                Item: { ...membership, status: "inactive" },
              }),
            );
          }
          return originalSend(command);
        };
        try {
          result(
            await updateSiteAdmin(
              event(
                { personId: "person", phone: "415-555-0108" },
                "manager",
                "siteManagerPhone",
              ),
            ),
            409,
          );
          assert.equal(
            (await get("PEOPLE", "PERSON#person")).phone,
            "415-555-0107",
          );
        } finally {
          ddb.send = originalSend;
        }
      },
    );
    await t.test(
      "local fixture cleanup is idempotent and preserves real artifacts",
      async () => {
        const { reconcileLocalCompliance } = await import(
          "./reconcile-local-compliance.mjs"
        );
        const raw = await get("SITE#site", "#META");
        await put({
          ...raw,
          compliance: { requiredChecksPerDay: 4, periodStart: "2026-01-15" },
          complianceLetters: {
            current: { url: "/sample-compliance-letter.pdf" },
            past: [{ s3Key: "synthetic/retained.pdf" }],
          },
        });
        const dry = await reconcileLocalCompliance({
          client: ddb,
          siteIds: ["site"],
        });
        assert.equal(dry.sampleLettersRemoved, 1);
        await reconcileLocalCompliance({
          apply: true,
          client: ddb,
          siteIds: ["site"],
        });
        assert.equal(
          (await get("SITE#site", "#META")).complianceLetters.past[0].s3Key,
          "synthetic/retained.pdf",
        );
        assert.equal(
          (
            await reconcileLocalCompliance({
              apply: true,
              client: ddb,
              siteIds: ["site"],
            })
          ).sitesChanged,
          0,
        );
      },
    );
    await t.test(
      "canonical periods, generated artifacts, and end-of-requirement state agree across APIs",
      async () => {
        const { pacificToday, addDays } = await import(
          "../src/lib/pacific-dates.js"
        );
        const { getSite } = await import("../src/handlers/site.js");
        const { endSiteTerms, listSiteTerms } = await import(
          "../src/handlers/admin-site-config.js"
        );
        const { getChecksReport } = await import(
          "../src/handlers/manager-reports.js"
        );
        const today = pacificToday();
        const start = addDays(today, -5);
        const term = {
          pk: "SITE#site",
          sk: `COMPLIANCE_TERMS#${start}#canonical`,
          termsVersionId: "canonical",
          effectiveStart: start,
          requiredChecksPerDay: 5,
          status: "active",
          reasons: ["6"],
        };
        await put(term);
        const raw = await get("SITE#site", "#META");
        await put({
          ...raw,
          latestComplianceTermsVersionId: "canonical",
          compliance: { perimeterChecksRequired: false },
          complianceLetters: {
            current: {
              termsVersionId: "canonical",
              s3Key: "synthetic/current.pdf",
              effectiveStart: start,
            },
            past: [],
          },
        });
        assert.equal(
          result(await getSite(event({}))).site.compliance,
          undefined,
        );
        assert.equal(
          result(await getSiteAdmin(event({}))).site.compliance
            .requiredChecksPerDay,
          5,
        );
        const dashboardEvent = {
          ...admin({}),
          queryStringParameters: { view: "compliance" },
        };
        const dashboard = result(await getAdminSite(dashboardEvent)).items.find(
          (row) => row.sk === "#META",
        );
        assert.equal(dashboard.compliance.requiredChecksPerDay, 5);
        assert.equal(
          dashboard.complianceLetters.current.termsVersionId,
          "canonical",
        );
        assert.equal(result(await listSiteTerms(admin({}))).terms.length, 1);
        // Recorded checks remain visible even after the requirement is closed.
        const occurred = `${today}T20:00:00.000Z`;
        await put({
          pk: "SITE#site",
          sk: "CHECK#synthetic",
          type: "check",
          checkId: "synthetic",
          status: "completed",
          startedAt: occurred,
          completedAt: occurred,
          gsi1pk: "SITE#site",
          gsi1sk: occurred,
        });
        result(await endSiteTerms(admin({})));
        const app = result(await getSiteAdmin(event({}))).site;
        assert.equal(app.compliance.perimeterChecksRequired, false);
        assert.equal(app.complianceLetters.current, null);
        assert.equal(app.complianceLetters.past[0].termsVersionId, "canonical");
        const endedDashboard = result(
          await getAdminSite(dashboardEvent),
        ).items.find((row) => row.sk === "#META");
        assert.deepEqual(endedDashboard.compliance, app.compliance);
        assert.equal(endedDashboard.complianceLetters.current, null);
        const report = result(await getChecksReport(event({})));
        assert.equal(report.requirement.required, false);
        assert.ok(report.days.some((day) => day.required === 5));
        assert.equal(report.days.find((day) => day.date === today).required, 0);
        assert.equal(report.totals.recorded, 1);
      },
    );
  } finally {
    client.destroy();
    ddb.destroy();
    await DynamoDbLocal.stop(port);
  }
});
