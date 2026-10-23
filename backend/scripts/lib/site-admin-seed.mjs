import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { createOversightOption } from "../../src/handlers/admin-oversight.js";
import { ddb } from "../../src/db.js";
import {
  previewSiteImport,
  applySiteImport,
} from "../../src/handlers/admin-site-imports.js";

export function assertLocalSeedTarget() {
  for (const name of [
    "AWS_ENDPOINT_URL_DYNAMODB",
    "AWS_ENDPOINT_URL_SQS",
    "AWS_ENDPOINT_URL_S3",
  ]) {
    const endpoint = new URL(process.env[name] || "https://invalid");
    if (
      endpoint.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
    ) {
      throw new Error(`${name} must point to a localhost emulator`);
    }
  }
  if (!/^gnp-local-/.test(process.env.DYNAMO_TABLE || ""))
    throw new Error("Seed requires a gnp-local-* table");
}

export async function seedLocalSiteAdmin() {
  assertLocalSeedTarget();
  const TableName = process.env.DYNAMO_TABLE;
  const Key = { pk: "LOCAL_SEED#SITE_ADMIN", sk: "#META" };
  const existing = await ddb.send(
    new GetCommand({ TableName, Key, ConsistentRead: true }),
  );
  if (existing.Item) return;
  const csv = await readFile(
    new URL("../../seeds/site-admin.csv", import.meta.url),
    "utf8",
  );
  const digest = createHash("sha256").update(csv).digest("hex");
  const event = (body, pathParameters = {}) => ({
    body: JSON.stringify(body),
    pathParameters,
    requestContext: {
      authorizer: {
        jwt: {
          claims: {
            sub: "local-admin",
            "cognito:groups": "compliance-supervisor",
          },
        },
      },
    },
  });
  const invoke = async (handler, request) => {
    const response = await handler(request);
    const result = JSON.parse(response.body);
    if (response.statusCode >= 400)
      throw new Error(`Seed import failed: ${result.error}`);
    return result;
  };
  for (const name of [
    "Department of Homelessness and Supportive Housing (HSH)",
    "Department of Public Health (DPH)",
  ]) {
    const response = await createOversightOption(
      event({ type: "department", name }),
    );
    const result = JSON.parse(response.body);
    if (
      response.statusCode >= 400 &&
      !(
        response.statusCode === 409 &&
        result.error === "oversight_option_exists"
      )
    ) {
      throw new Error(`Seed department setup failed: ${result.error}`);
    }
  }
  const preview = await invoke(
    previewSiteImport,
    event({ csv, fileName: "site-admin.csv" }),
  );
  console.log("[seed] preview counts:", preview.counts);
  if (preview.counts.conflict || preview.counts.invalid)
    throw new Error("Seed CSV has unresolved rows; nothing applied");
  const expected = Object.values(preview.counts).reduce(
    (sum, count) => sum + count,
    0,
  );
  let result;
  do {
    result = await invoke(
      applySiteImport,
      event(
        { previewVersion: preview.previewVersion, idempotencyKey: digest },
        { importId: preview.importId },
      ),
    );
  } while (result.status === "applying");
  if (
    result.resultStatus !== "succeeded" ||
    result.outcomes.applied !== expected
  ) {
    console.error("[seed] outcomes:", result.outcomes);
    console.error(
      "[seed] unresolved rows:",
      result.rows
        .filter((row) => row.outcome !== "applied")
        .map(({ rowNumber, reasonCode, outcome }) => ({
          rowNumber,
          reasonCode,
          outcome,
        })),
    );
    throw new Error(`Seed did not import all ${expected} rows`);
  }
  await ddb.send(
    new PutCommand({
      TableName,
      Item: {
        ...Key,
        digest,
        importId: preview.importId,
        seededAt: new Date().toISOString(),
      },
    }),
  );
  console.log(`[seed] imported all ${expected} site-admin rows`);
}
