import { it, expect } from "vitest";
import {
  migrationTarget,
  monitoringUpdates,
} from "./enhanced-monitoring-migration.mjs";
it("requires explicit remote target and write confirmation", () => {
  expect(() => migrationTarget(["--remote"], {})).toThrow();
  expect(() =>
    migrationTarget(
      ["--remote", "--table=dev", "--region=us-west-2", "--apply"],
      {},
    ),
  ).toThrow();
  expect(
    migrationTarget(["--remote", "--table=dev", "--region=us-west-2"], {})
      .apply,
  ).toBe(false);
  expect(
    migrationTarget(
      [
        "--remote",
        "--table=dev",
        "--region=us-west-2",
        "--apply",
        "--confirm-table=dev",
      ],
      {},
    ).apply,
  ).toBe(true);
  expect(() =>
    migrationTarget([], {
      DYNAMO_TABLE: "dev",
      AWS_ENDPOINT_URL_DYNAMODB: "https://dynamodb.us-west-2.amazonaws.com",
    }),
  ).toThrow();
});
it("preserves explicit flags and conditionally removes legacy fields", () => {
  const site = {
    pk: "SITE#one",
    sk: "#META",
    compliance: { currentTier: 2, underEnhancedMonitoring: false },
  };
  const [update] = monitoringUpdates(site, "table");
  expect(update.ExpressionAttributeValues[":new"]).toEqual({
    underEnhancedMonitoring: false,
  });
  expect(update.ExpressionAttributeValues[":old"]).toEqual(site.compliance);
  const [period] = monitoringUpdates(
    { pk: "SITE#one", sk: "COMPLIANCE_TERMS#one", correctiveActionTier: 2 },
    "table",
  );
  expect(period.ExpressionAttributeValues[":flag"]).toBe(true);
  expect(period.ConditionExpression).toContain(
    "attribute_not_exists(underEnhancedMonitoring)",
  );
  expect(
    monitoringUpdates(
      {
        pk: "SITE#one",
        sk: "#META",
        compliance: { underEnhancedMonitoring: true },
      },
      "table",
    ),
  ).toEqual([]);
});
