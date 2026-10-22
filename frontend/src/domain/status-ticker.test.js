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
  it("orders closure above age above overdue above scheduled/on hold above filed", () => {
    const task = {
      ...filed,
      ticketStatus: "Closed",
      ticketClosedReason: "999",
      createdAt: "2026-01-01",
      ticketResponseOverdue: true,
    };
    expect(ticker(task).key).toBe("cityClosed");
    task.ticketClosedReason = "";
    expect(ticker(task).key).toBe("closedUnknown");
    task.ticketStatus = "Scheduled";
    expect(ticker(task).key).toBe("old");
    task.createdAt = new Date(now - 30 * 86400000).toISOString();
    expect(ticker(task).key).toBe("overdue");
    task.ticketResponseOverdue = false;
    expect(ticker(task).key).toBe("scheduled");
    task.ticketStatus = "On hold";
    expect(ticker(task).key).toBe("onHold");
    task.ticketStatus = "Open";
    expect(ticker(task).key).toBe("filed");
  });
  it("uses original creation, never updatedAt, for age", () => {
    expect(
      ticker({
        ...filed,
        createdAt: "2026-01-01",
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
    ).toMatchObject({ key: "actionTaken", tone: "action", icon: "dot" });
    expect(
      ticker({
        status: "completed",
        canBeInProgress: false,
        completionMethod: "site_team_resolved",
      }),
    ).toMatchObject({ key: "resolved", tone: "success" });
  });
});
