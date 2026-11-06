import { test } from "vitest";
import assert from "node:assert/strict";
import {
  alsoPath,
  backPath,
  contactShown,
  isOverview,
  listFilter,
  showsTotal,
  toggleTile,
  withPeriod,
} from "./site-rules.js";

const october = { kind: "month", month: "2026-10" };
const september = { kind: "month", month: "2026-09" };
const RESPONSE = ["overdue", "late", "awaiting", "onTime", "unknown"];

test("only Overview's own path counts as Overview", () => {
  assert.deepEqual(
    [
      "/insights",
      "/insights/?show=all",
      "/insights/trends",
      "/insights/sites/s1",
    ].map(isOverview),
    [true, true, false, false],
  );
});

test("the way back keeps Overview's filters and takes the Site's period", () => {
  assert.equal(
    withPeriod("/insights?period=2026-10&show=all", september),
    "/insights?period=2026-09&show=all",
  );
  // Same period: the path Overview saved, so it finds its place by exact match.
  assert.equal(
    withPeriod("/insights?period=2026-10&show=all&cursor=50", october),
    "/insights?period=2026-10&show=all&cursor=50",
  );
});

test("Back goes to the Overview asked for, else the last one seen, else plain Overview", () => {
  assert.equal(
    backPath({
      asked: "/insights?show=all&period=2026-10",
      remembered: "/insights?show=top&period=2026-10",
      period: october,
    }),
    "/insights?show=all&period=2026-10",
  );
  // Another Insights page isn't a way back to Overview.
  assert.equal(
    backPath({
      asked: "/insights/trends",
      remembered: "/insights?show=top&period=2026-10",
      period: october,
    }),
    "/insights?show=top&period=2026-10",
  );
  assert.equal(
    backPath({ asked: "/insights/trends", remembered: "", period: october }),
    "/insights?period=2026-10",
  );
});

test("a Site opened without a period goes back to Overview's default period", () => {
  assert.equal(
    backPath({
      asked: "/insights?period=2026-08&show=all",
      remembered: "",
      period: null,
    }),
    "/insights?show=all",
  );
});

test("Back at another period is noted beside the Overview path", () => {
  assert.equal(
    alsoPath("/insights?period=2026-10", "/insights?period=2026-10"),
    "",
  );
  assert.equal(
    alsoPath("/insights?period=2026-10", "/insights?period=2026-09"),
    "/insights?period=2026-09",
  );
});

test("a tile is added in tile order, and picking it again takes it off", () => {
  assert.equal(
    toggleTile(RESPONSE, "overdue,late", "awaiting"),
    "overdue,late,awaiting",
  );
  assert.equal(toggleTile(RESPONSE, "late", "overdue"), "overdue,late");
  assert.equal(toggleTile(RESPONSE, "overdue,late", "late"), "overdue");
  assert.equal(toggleTile(RESPONSE, "overdue", "overdue"), "");
  assert.equal(toggleTile(RESPONSE, "", "onTime"), "onTime");
});

test("a concern's list asks by concern, not by the tiles", () => {
  assert.deepEqual(
    listFilter("responseState", { tile: "overdue", concern: "" }),
    {
      responseState: "overdue",
    },
  );
  assert.deepEqual(
    listFilter("responseState", { tile: "", concern: "slowResponse" }),
    { concern: "slowResponse" },
  );
});

test("Checks always show a total; Issues only when 30 days doesn't already say it", () => {
  assert.deepEqual(
    [
      showsTotal("completedPerimeterChecks", 30),
      showsTotal("issuesCreated", 31),
      showsTotal("issuesCreated", 30),
      showsTotal("singleIssueReports", 31),
    ],
    [true, true, false, false],
  );
});

const reported = {
  state: "missing",
  reasonCodes: ["no_email"],
  email: null,
  phone: "4155550100",
};

test("until Manage's record is read, the report's contact and state show", () => {
  assert.deepEqual(contactShown("public", reported, undefined, false), {
    person: reported,
    state: "missing",
    reasonCodes: ["no_email"],
  });
});

test("once read, Manage's public contact gives both the details and the state", () => {
  const person = { email: "a@example.org", phone: "4155550100" };
  assert.deepEqual(contactShown("public", reported, person, true), {
    person,
    state: "available",
    reasonCodes: [],
  });
  assert.deepEqual(
    contactShown("public", reported, { phone: "4155550100" }, true).reasonCodes,
    ["no_email"],
  );
  assert.deepEqual(contactShown("public", reported, undefined, true), {
    person: undefined,
    state: "missing",
    reasonCodes: ["no_email", "no_phone"],
  });
});

test("a Site contact on the record with only a name still counts", () => {
  const site = { state: "missing", reasonCodes: ["no_site_contact"] };
  assert.equal(
    contactShown("site", site, { firstName: "Sam" }, true).state,
    "available",
  );
  assert.deepEqual(contactShown("site", site, undefined, true), {
    person: undefined,
    state: "missing",
    reasonCodes: ["no_site_contact"],
  });
});
