import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { statusTicker } from "./status-ticker.js";
import { setDuplicateUiSite } from "../services/feature-flags.js";
const now = Date.parse("2026-10-22T12:00:00Z");
const filed = {
  status: "in_progress",
  appActionResults: [
    { code: "create_311_ticket", payload: { tickets: [{ srNum: "123" }] } },
  ],
};
const ticker = (task) => statusTicker(task, { now });
beforeEach(() =>
  setDuplicateUiSite({ featureFlags: { duplicateDetection: true } }),
);
afterEach(() => setDuplicateUiSite(null));
describe("status ticker priorities", () => {
  it.each(["911", "415-553-0123", "+1 (415) 553-0123"])(
    "marks %s red, without marking other calls red",
    (phoneNumber) => {
      expect(ticker({ phoneNumber }).tone).toBe("danger");
      expect(ticker({ phoneNumber: "311" })).toMatchObject({
        key: "needsAction",
        tone: "action",
        icon: "dot",
      });
    },
  );
  it("orders duplicate, pending, seen count, and default including silent failure", () => {
    const task = {
      phoneNumber: "911",
      duplicate: {},
      duplicateCheckState: "pending",
      duplicateSeenCount: 3,
    };
    expect(ticker(task).key).toBe("duplicate");
    delete task.duplicate;
    expect(ticker(task).key).toBe("checking");
    task.duplicateCheckState = "unavailable";
    expect(ticker(task)).toMatchObject({
      key: "seen",
      count: 3,
      tone: "warning",
    });
    task.duplicateSeenCount = 1;
    expect(ticker(task)).toMatchObject({ key: "needsAction", tone: "danger" });
  });
  it("hides duplicate statuses when the feature is disabled", () => {
    setDuplicateUiSite(null);
    expect(
      ticker({
        duplicate: {},
        duplicateCheckState: "pending",
        duplicateSeenCount: 3,
      }).key,
    ).toBe("needsAction");
  });
  it("orders closure above overdue above scheduled/on hold above filed", () => {
    const task = {
      ...filed,
      ticketStatus: "Closed",
      ticketClosedReason: "999",
      createdAt: "2026-10-20",
      ticketResponseOverdue: true,
    };
    expect(ticker(task).key).toBe("cityClosed");
    task.ticketClosedReason = "";
    expect(ticker(task).key).toBe("cityClosed");
    task.ticketStatus = "Scheduled";
    expect(ticker(task).key).toBe("overdue");
    task.ticketResponseOverdue = false;
    expect(ticker(task).key).toBe("scheduled");
    task.ticketStatus = "On hold";
    expect(ticker(task).key).toBe("onHold");
    task.ticketStatus = "Open";
    expect(ticker(task).key).toBe("filed");
  });
  it.each(["open", "in_progress", "completed", "cannot_do"])(
    "retains only resolved status for %s in History at 14 days",
    (status) => {
      const task = {
        ...filed,
        status,
        createdAt: new Date(now - 14 * 86400000).toISOString(),
        ticketStatus: "Closed",
        completionMethod: "site_team_resolved",
        duplicate: {},
        duplicateCheckState: "pending",
      };
      expect(ticker(task).key).toBe("resolved");
      expect(statusTicker(task, { now, history: true }).key).toBe("resolved");
    },
  );
  it("uses original creation, never updatedAt, for age", () => {
    expect(
      ticker({
        ...filed,
        createdAt: new Date(now - 8 * 86400000).toISOString(),
        updatedAt: new Date(now).toISOString(),
      }).key,
    ).toBe("old");
    expect(ticker({ ...filed, createdAt: "invalid" }).key).toBe("filed");
  });
  it("distinguishes phone calls, on-site work, direct completion, and explicit resolution", () => {
    expect(
      ticker({ status: "in_progress", kind: "non_actionable_escalation" }).key,
    ).toBe("called");
    expect(ticker({ status: "in_progress", kind: "action" }).key).toBe(
      "needsAction",
    );
    expect(
      ticker({ status: "completed", canBeInProgress: false }),
    ).toMatchObject({ key: "" });
    expect(
      ticker({
        status: "completed",
        canBeInProgress: false,
        completionMethod: "site_team_resolved",
      }),
    ).toMatchObject({ key: "resolved", tone: "success" });
  });
});

describe("expiration routes cards to history", () => {
  it.each(["open", "in_progress", "completed", "cannot_do"])(
    "archives %s regardless of overrides",
    async (status) => {
      const { homeTaskStatus, homeTabForStatus } = await import(
        "./home-tasks.js"
      );
      const task = {
        status,
        createdAt: new Date(now - 14 * 86400000).toISOString(),
      };
      expect(
        homeTabForStatus(
          homeTaskStatus(task, { status: "in_progress" }, new Date(now)),
        ),
      ).toBe("history");
      task.createdAt = new Date(now - 14 * 86400000 + 1).toISOString();
      if (status === "open" || status === "in_progress")
        expect(
          homeTabForStatus(homeTaskStatus(task, null, new Date(now))),
        ).not.toBe("history");
    },
  );
});

describe("resolution evidence shared by ticker and expiration", () => {
  it("uses completedAt only with an explicit resolution marker", async () => {
    const { unresolvedExpiryAt } = await import("./home-tasks.js");
    const task = {
      status: "completed",
      completionMethod: "site_team_resolved",
      createdAt: "2026-10-01T12:00:00Z",
      completedAt: "2026-10-02T12:00:00Z",
    };
    expect(
      statusTicker(task, { now: Date.parse("2026-10-03T12:00:00Z") }).key,
    ).toBe("resolved");
    expect(unresolvedExpiryAt(task, now)).toBe("");
    task.completedAt = "2026-10-16T12:00:00Z";
    expect(unresolvedExpiryAt(task, now)).toBe("2026-10-15T12:00:00.000Z");
  });
  it.each(["manual", "user_confirmed", "custom_action", "311_filed"])(
    "does not treat %s action completion as resolution",
    async (completionMethod) => {
      const { unresolvedExpiryAt } = await import("./home-tasks.js");
      const task = {
        status: "completed",
        canBeInProgress: false,
        completionMethod,
        createdAt: "2026-10-01T12:00:00Z",
        completedAt: "2026-10-02T12:00:00Z",
        resolvedAt: "2026-10-02T12:00:00Z",
      };
      expect(
        statusTicker(task, { now: Date.parse("2026-10-03T12:00:00Z") }).key,
      ).toBe("");
      expect(unresolvedExpiryAt(task, now)).toBe("2026-10-15T12:00:00.000Z");
    },
  );
  it("does not infer resolution from a legacy completedAt alone", async () => {
    const { unresolvedExpiryAt } = await import("./home-tasks.js");
    const task = {
      status: "completed",
      createdAt: "2026-10-01T12:00:00Z",
      completedAt: "2026-10-02T12:00:00Z",
    };
    expect(
      statusTicker(task, {
        history: true,
        now: Date.parse("2026-10-03T12:00:00Z"),
      }).key,
    ).toBe("");
    expect(unresolvedExpiryAt(task, now)).toBe("2026-10-15T12:00:00.000Z");
  });
  it.each(["site_team_resolved", undefined])(
    "recognizes explicit resolution with method %s before expiry",
    async (completionMethod) => {
      const { unresolvedExpiryAt } = await import("./home-tasks.js");
      const task = {
        status: "completed",
        completionMethod,
        createdAt: "2026-10-01T12:00:00Z",
        resolvedAt: "2026-10-02T12:00:00Z",
      };
      expect(
        statusTicker(task, { now: Date.parse("2026-10-03T12:00:00Z") }).key,
      ).toBe("resolved");
      expect(unresolvedExpiryAt(task, now)).toBe("");
      expect(ticker(task).key).toBe("resolved");
      task.resolvedAt = "2026-10-16T12:00:00Z";
      expect(unresolvedExpiryAt(task, now)).toBe("2026-10-15T12:00:00.000Z");
    },
  );
});

it("warns after seven days, then hides age after archival", () => {
  const at = (days) => ({
    ...filed,
    createdAt: new Date(now - days * 86400000).toISOString(),
  });
  expect(ticker(at(7)).key).toBe("filed");
  expect(ticker(at(7.01)).key).toBe("old");
  expect(ticker(at(13.99)).key).toBe("old");
  expect(ticker(at(14)).key).toBe("");
  expect(statusTicker(at(8), { now, history: true }).key).toBe("");
});

describe("background 311 filing", () => {
  const tapped = (appActionStatus, reason = "sf311_timeout") => ({
    status: "in_progress",
    inProgressActionKind: "311_filed",
    appActionStatus,
    appActionResults:
      appActionStatus === "failed"
        ? [{ code: "create_311_ticket", status: "failed", reason }]
        : [],
  });

  it("shows a spinner while the filing is queued", () => {
    expect(ticker(tapped("queued"))).toMatchObject({
      key: "filing",
      tone: "progress",
      icon: "spinner",
    });
  });

  it("warns when the filing failed", () => {
    expect(ticker(tapped("failed"))).toMatchObject({
      key: "filingFailed",
      tone: "warning",
    });
  });

  it("shows the filed ticket once the worker files it", () => {
    expect(ticker({ ...filed, inProgressActionKind: "311_filed" }).key).toBe(
      "filed",
    );
  });
});
