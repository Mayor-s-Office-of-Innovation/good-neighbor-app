import { describe, expect, it } from "vitest";

import { t } from "../i18n/i18n.js";
import {
  appActionFailureMessage,
  canRetry311Filing,
  filing311FailureMessage,
  filing311State,
  isAccepted311Filing,
  isFiled311Completion,
  submitted311ServiceRequestNumber,
} from "./task-actions.js";

describe("task action helpers", () => {
  it.each(["completed", "in_progress"])(
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
      t("taskAction.failure.featureDisabled"),
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

describe("background 311 filing", () => {
  /** @param {string} appActionStatus @param {string} [reason] */
  const tapped = (appActionStatus, reason = "sf311_timeout") => ({
    status: "in_progress",
    inProgressActionKind: "311_filed",
    appActionStatus,
    appActionResults:
      appActionStatus === "failed"
        ? [{ code: "create_311_ticket", status: "failed", reason }]
        : [],
  });

  it("reads queued and failed filings from the task", () => {
    expect(filing311State(tapped("queued"))).toBe("queued");
    expect(filing311State(tapped("failed"))).toBe("failed");
    expect(filing311State({ ...tapped("queued"), status: "open" })).toBe("");
    expect(
      filing311State({ ...tapped("queued"), inProgressActionKind: "button" }),
    ).toBe("");
  });

  it("accepts a queued filing as well as a filed one", () => {
    expect(isAccepted311Filing(tapped("queued"))).toBe(true);
    expect(isAccepted311Filing(tapped("failed"))).toBe(false);
    expect(isAccepted311Filing({ status: "open" })).toBe(false);
  });

  it.each(["sf311_timeout", "attachment_submission_failed", "sf311_error"])(
    "offers a retry after %s",
    (reason) => {
      expect(canRetry311Filing(tapped("failed", reason))).toBe(true);
    },
  );

  it.each([
    "missing_location",
    "insufficient_classifier_information",
    "responsible_agency_not_found",
    "sf311_creation_uncertain_requires_reconciliation",
  ])("offers no retry after %s", (reason) => {
    expect(canRetry311Filing(tapped("failed", reason))).toBe(false);
  });

  it("explains each kind of failure without asking for a pointless retry", () => {
    expect(filing311FailureMessage(tapped("queued"))).toBe("");
    expect(filing311FailureMessage(tapped("failed"))).toBe(
      t("taskAction.failure.sf311Timeout"),
    );
    expect(
      filing311FailureMessage(
        tapped("failed", "sf311_creation_uncertain_requires_reconciliation"),
      ),
    ).toBe(t("taskAction.failure.creationUncertain"));
    expect(
      filing311FailureMessage(tapped("failed", "attachment_submission_failed")),
    ).toBe(t("taskAction.failure.photosFailed"));
    expect(
      filing311FailureMessage(tapped("failed", "missing_service_code")),
    ).toBe(t("taskAction.failure.cannotFile"));
  });
});
