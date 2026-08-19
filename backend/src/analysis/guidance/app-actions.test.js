import { describe, expect, it } from "vitest";
import {
  executeAppActions,
  initialAppActionStatus,
  is311SubmissionEnabled,
  summarizeAppActionResults,
} from "./app-actions.js";

describe("app action execution", () => {
  const now = new Date("2026-08-18T12:00:00.000Z");

  it("keeps phone actions as user-facing metadata", () => {
    expect(
      executeAppActions(
        [{ code: "open_phone", payload: { phoneNumber: "911" } }],
        { now },
      ),
    ).toEqual([
      {
        code: "open_phone",
        status: "requires_user_action",
        payload: { phoneNumber: "911" },
        recordedAt: "2026-08-18T12:00:00.000Z",
      },
    ]);
  });

  it("skips 311 submission unless the feature flag is enabled", () => {
    expect(is311SubmissionEnabled({ GNP_311_SUBMISSION_ENABLED: "false" })).toBe(
      false,
    );
    expect(
      executeAppActions(
        [{ code: "create_311_ticket", payload: { category311: "Cleaning" } }],
        { env: {}, now, taskId: "task-1" },
      ),
    ).toEqual([
      {
        code: "create_311_ticket",
        status: "skipped",
        reason: "feature_disabled",
        payload: { category311: "Cleaning" },
        recordedAt: "2026-08-18T12:00:00.000Z",
      },
    ]);
  });

  it("records a stub 311 submission when the feature flag is enabled", () => {
    expect(
      executeAppActions(
        [{ code: "create_311_ticket", payload: { category311: "Cleaning" } }],
        {
          env: { GNP_311_SUBMISSION_ENABLED: "true" },
          now,
          taskId: "task-1",
        },
      ),
    ).toEqual([
      {
        code: "create_311_ticket",
        status: "submitted",
        externalId: "stub-311-task-1",
        payload: { category311: "Cleaning" },
        recordedAt: "2026-08-18T12:00:00.000Z",
      },
    ]);
  });

  it("leaves email and form integrations unconfigured", () => {
    const results = executeAppActions(
      [{ code: "compose_email" }, { code: "create_fire_hazard_report" }],
      { now },
    );
    expect(results).toMatchObject([
      { code: "compose_email", status: "not_configured" },
      { code: "create_fire_hazard_report", status: "not_configured" },
    ]);
    expect(summarizeAppActionResults(results)).toBe("not_configured");
  });

  it("summarizes initial and completed app action state", () => {
    expect(initialAppActionStatus([])).toBe("none");
    expect(initialAppActionStatus([{ code: "open_phone" }])).toBe("pending");
    expect(summarizeAppActionResults([])).toBe("none");
    expect(
      summarizeAppActionResults([
        {
          code: "open_phone",
          status: "requires_user_action",
          recordedAt: "2026-08-18T12:00:00.000Z",
        },
      ]),
    ).toBe("requires_user_action");
  });
});
