import { beforeEach, describe, expect, it, vi } from "vitest";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
import { sitePrimaryContactChange } from "./site-primary-contact.js";

/** @param {string} id */
const staff = (id) => ({
  userId: id,
  programId: "program",
  firstName: id,
  lastName: "Manager",
  email: `${id}@example.org`,
  phone: "1234567890",
  status: "active",
});
/** @param {string} id @param {string} createdAt */
const assignment = (id, createdAt) => ({
  ...staff(id),
  sk: `ASSIGNED_USER#${id}`,
  createdAt,
});
/** @type {Record<string, any>[]} */
let rows;
/** @type {Record<string, any>} */
let site;
beforeEach(() => {
  rows = [];
  site = { managerRosterRevision: "old-revision", updatedAt: "before" };
  send.mockReset().mockImplementation(async ({ input }) => {
    if (input.Key?.sk === "#META") return { Item: site };
    if (input.Key?.sk.startsWith("USER#"))
      return { Item: staff(input.Key.sk.slice(5)) };
    return {
      Items: rows.filter((row) =>
        row.sk.startsWith(input.ExpressionAttributeValues[":prefix"]),
      ),
    };
  });
});
describe("automatic site primary contact", () => {
  it("assigns the first manager with full contact details", async () => {
    const { Update } = await sitePrimaryContactChange("table", "site", "now", {
      add: assignment("one", "2026-01-01"),
    });
    expect(Update.ExpressionAttributeValues[":userId"]).toBe("one");
    expect(Update.ExpressionAttributeValues[":contact"]).toEqual({
      firstName: "one",
      lastName: "Manager",
      email: "one@example.org",
      phone: "1234567890",
      phoneExtension: "",
    });
  });
  it("keeps the oldest assignment when another manager is added", async () => {
    rows = [assignment("old", "2026-01-01")];
    const { Update } = await sitePrimaryContactChange("table", "site", "now", {
      add: assignment("new", "2026-02-01"),
    });
    expect(Update.ExpressionAttributeValues[":userId"]).toBe("old");
  });
  it("keeps the first-assigned primary when timestamps tie", async () => {
    site.primaryContactUserId = "z-first";
    rows = [assignment("z-first", "2026-01-01")];
    const { Update } = await sitePrimaryContactChange("table", "site", "now", {
      add: assignment("a-second", "2026-01-01"),
    });
    expect(Update.ExpressionAttributeValues[":userId"]).toBe("z-first");
  });
  it("initializes a revision for legacy sites", async () => {
    site = {};
    const { Update } = await sitePrimaryContactChange(
      "table",
      "site",
      "now",
      {},
    );
    expect(Update.ConditionExpression).toContain(
      "attribute_not_exists(managerRosterRevision)",
    );
    expect(Update.ExpressionAttributeValues).not.toHaveProperty(":expected");
  });
  it("promotes the next oldest, not query order, on primary removal", async () => {
    rows = [
      assignment("newest", "2026-03-01"),
      assignment("old", "2026-01-01"),
      assignment("next", "2026-02-01"),
    ];
    const { Update } = await sitePrimaryContactChange("table", "site", "now", {
      removeUserId: "old",
    });
    expect(Update.ExpressionAttributeValues[":userId"]).toBe("next");
  });
  it("does not change primary when a newer manager is removed", async () => {
    rows = [assignment("old", "2026-01-01"), assignment("new", "2026-02-01")];
    const { Update } = await sitePrimaryContactChange("table", "site", "now", {
      removeUserId: "new",
    });
    expect(Update.ExpressionAttributeValues[":userId"]).toBe("old");
  });
  it("clears both fields when the last manager and its access projection are removed", async () => {
    rows = [
      assignment("one", "2026-01-01"),
      {
        ...assignment("one", "2026-02-01"),
        sk: "MANAGER_MEMBERSHIP#one",
        membershipId: "one",
      },
    ];
    const { Update } = await sitePrimaryContactChange("table", "site", "now", {
      removeUserId: "one",
      removeMembershipId: "one",
    });
    expect(Update.UpdateExpression).toContain(
      "REMOVE primaryContactUserId, primaryContact",
    );
    expect(Update.ExpressionAttributeValues).not.toHaveProperty(":contact");
  });
  it("loads contact details for imported assignments without snapshots", async () => {
    rows = [
      {
        sk: "ASSIGNED_USER#one",
        userId: "one",
        programId: "program",
        status: "active",
        createdAt: "2026-01-01",
      },
    ];
    const { Update } = await sitePrimaryContactChange(
      "table",
      "site",
      "now",
      {},
    );
    expect(Update.ExpressionAttributeValues[":contact"]?.email).toBe(
      "one@example.org",
    );
  });
  it("supports standalone memberships, and excludes inactive ones", async () => {
    rows = [
      {
        sk: "MANAGER_MEMBERSHIP#inactive",
        name: "Old Person",
        status: "inactive",
      },
      {
        sk: "MANAGER_MEMBERSHIP#active",
        membershipId: "active",
        name: "Alex Rivera",
        email: "alex@example.org",
        status: "active",
      },
    ];
    const { Update } = await sitePrimaryContactChange(
      "table",
      "site",
      "now",
      {},
    );
    expect(Update.ExpressionAttributeValues[":contact"]?.firstName).toBe(
      "Alex",
    );
    expect(Update.UpdateExpression).toContain("REMOVE primaryContactUserId");
  });
  it("guards the revision and timestamp read before the roster", async () => {
    const { Update } = await sitePrimaryContactChange(
      "table",
      "site",
      "now",
      {},
    );
    expect(send.mock.calls[0][0].input.Key.sk).toBe("#META");
    expect(Update.ConditionExpression).toContain(
      "managerRosterRevision = :expected",
    );
    expect(Update.ConditionExpression).toContain(
      "updatedAt = :expectedUpdatedAt",
    );
    expect(Update.ExpressionAttributeValues[":expected"]).toBe("old-revision");
    expect(Update.ExpressionAttributeValues[":revision"]).not.toBe(
      "old-revision",
    );
  });
});

it("preserves the preferred tie after discarding an inactive oldest user", async () => {
  site.primaryContactUserId = "z";
  rows = [
    assignment("inactive", "2020"),
    assignment("a", "2021"),
    assignment("z", "2021"),
  ];
  const original = send.getMockImplementation();
  send.mockImplementation(async (command) =>
    command.input.Key?.sk === "USER#inactive"
      ? { Item: { status: "inactive" } }
      : original?.(command),
  );
  const { Update } = await sitePrimaryContactChange("table", "site", "now");
  expect(Update.ExpressionAttributeValues[":userId"]).toBe("z");
});

it("does not merge distinct identified managers sharing an email", async () => {
  const { oldestSiteManager } = await import("./site-primary-contact.js");
  const result = oldestSiteManager([
    {
      sk: "MANAGER_MEMBERSHIP#old",
      userId: "old",
      email: "shared@example.org",
      createdAt: "2020",
    },
    { ...assignment("new", "2021"), email: "shared@example.org" },
  ]);
  expect(result?.userId).toBe("old");
});

it("does not guess an identity for ambiguous email-only membership", async () => {
  const { oldestSiteManager } = await import("./site-primary-contact.js");
  const result = oldestSiteManager([
    {
      sk: "MANAGER_MEMBERSHIP#legacy",
      email: "shared@example.org",
      createdAt: "2020",
    },
    { ...assignment("one", "2021"), email: "shared@example.org" },
    { ...assignment("two", "2022"), email: "shared@example.org" },
  ]);
  expect(result?.userId).toBeUndefined();
});
