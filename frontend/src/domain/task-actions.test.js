import { describe, expect, it } from "vitest";

import {
  appActionFailureMessage,
  isFiled311Completion,
  submitted311ServiceRequestNumber,
} from "./task-actions.js";

describe("task action helpers", () => {
  it.each(["completed", "in_progress", "cannot_do"])(
    "does not report a saved %s action as failed because of background 311 results",
    (status) => {
      for (const code of ["create_311_ticket", "close_311_ticket"]) {
        expect(
          appActionFailureMessage({
            status,
            appActionResults: [{ code, status: "failed", reason: "21" }],
          }),
        ).toBeNull();
      }
    },
  );

  it("still reports an action failure that leaves the task open", () => {
    expect(
      appActionFailureMessage({
        status: "open",
        appActionResults: [
          {
            code: "create_311_ticket",
            status: "failed",
            reason: "sf311_timeout",
          },
        ],
      }),
    ).toContain("didn't respond in time");
  });

  it("still rejects explicit filing without a submitted ticket on a completed task", () => {
    const task = {
      status: "completed",
      appActionResults: [
        {
          code: "create_311_ticket",
          status: "failed",
          reason: "missing_location",
        },
      ],
    };
    expect(isFiled311Completion(task)).toBe(false);
    expect(
      appActionFailureMessage(task, { includeUnsubmitted311: true }),
    ).toContain("no location set");
  });

  it("requires an acted-on task with a submitted 311 result", () => {
    expect(
      isFiled311Completion({
        status: "completed",
        appActionResults: [{ code: "create_311_ticket", status: "submitted" }],
      }),
    ).toBe(true);
    expect(
      isFiled311Completion({
        status: "in_progress",
        appActionResults: [{ code: "create_311_ticket", status: "submitted" }],
      }),
    ).toBe(true);

    expect(
      isFiled311Completion({
        status: "completed",
        appActionResults: [{ code: "create_311_ticket", status: "skipped" }],
      }),
    ).toBe(false);
    expect(
      isFiled311Completion({
        status: "open",
        appActionResults: [{ code: "create_311_ticket", status: "submitted" }],
      }),
    ).toBe(false);
  });

  it("only reports skipped 311 results when explicitly requested", () => {
    const task = {
      appActionResults: [
        {
          code: "create_311_ticket",
          status: "skipped",
          reason: "feature_disabled",
        },
      ],
    };

    expect(appActionFailureMessage(task)).toBeNull();
    expect(appActionFailureMessage(task, { includeUnsubmitted311: true })).toBe(
      "We couldn't complete the 311 submission. Please try again.",
    );
  });
});

describe("submitted311ServiceRequestNumber", () => {
  it("reads the filed ticket number from the submitted app action", () => {
    expect(
      submitted311ServiceRequestNumber({
        appActionResults: [
          {
            code: "create_311_ticket",
            status: "submitted",
            payload: { tickets: [{ srNum: "LOCAL-SR-000001" }] },
          },
        ],
      }),
    ).toBe("LOCAL-SR-000001");
  });
});
