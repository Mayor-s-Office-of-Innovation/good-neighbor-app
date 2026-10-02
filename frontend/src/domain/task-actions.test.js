import { describe, expect, it } from "vitest";

import {
  appActionFailureMessage,
  isFiled311Completion,
  submitted311ServiceRequestNumber,
} from "./task-actions.js";

describe("task action helpers", () => {
  it("requires a completed task with a submitted 311 result", () => {
    expect(
      isFiled311Completion({
        status: "completed",
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
