import { describe, expect, it } from "vitest";
import {
  executeAppActions,
  initialAppActionStatus,
  is311SubmissionEnabled,
  summarizeAppActionResults,
} from "./app-actions.js";

describe("app action execution", () => {
  const now = new Date("2026-08-18T12:00:00.000Z");

  it("records legacy phone actions without routing to a phone app", async () => {
    expect(
      await executeAppActions(
        [{ code: "open_phone", payload: { phoneNumber: "911" } }],
        { now },
      ),
    ).toEqual([
      {
        code: "open_phone",
        status: "recorded",
        payload: { phoneNumber: "911" },
        recordedAt: "2026-08-18T12:00:00.000Z",
      },
    ]);
  });

  it("skips 311 submission unless the feature flag is enabled", async () => {
    expect(
      is311SubmissionEnabled({ GNP_311_SUBMISSION_ENABLED: "false" }),
    ).toBe(false);
    expect(
      await executeAppActions(
        [
          {
            code: "create_311_ticket",
            payload: { serviceCodeOrAction: "1.1.4.7.20.0" },
          },
        ],
        { env: {}, now, taskId: "task-1" },
      ),
    ).toEqual([
      {
        code: "create_311_ticket",
        status: "skipped",
        reason: "feature_disabled",
        payload: { serviceCodeOrAction: "1.1.4.7.20.0" },
        recordedAt: "2026-08-18T12:00:00.000Z",
      },
    ]);
  });

  it("runs only app actions for the requested trigger", async () => {
    const actions = [
      {
        code: "create_311_ticket",
        payload: {
          serviceCodeOrAction: "1.1.4.7.20.0",
          executionTrigger: "task_created",
        },
      },
      {
        code: "open_phone",
        payload: { phoneNumber: "911" },
      },
    ];

    expect(
      await executeAppActions(actions, {
        env: { GNP_311_SUBMISSION_ENABLED: "false" },
        now,
        trigger: "user_confirmed",
      }),
    ).toEqual([
      {
        code: "open_phone",
        status: "recorded",
        payload: { phoneNumber: "911" },
        recordedAt: "2026-08-18T12:00:00.000Z",
      },
    ]);

    expect(
      await executeAppActions(actions, {
        env: { GNP_311_SUBMISSION_ENABLED: "false" },
        now,
        trigger: "task_created",
      }),
    ).toEqual([
      {
        code: "create_311_ticket",
        status: "skipped",
        reason: "feature_disabled",
        payload: {
          serviceCodeOrAction: "1.1.4.7.20.0",
          executionTrigger: "task_created",
        },
        recordedAt: "2026-08-18T12:00:00.000Z",
      },
    ]);
  });

  it("records a failed 311 submission when config is incomplete", async () => {
    expect(
      await executeAppActions(
        [
          {
            code: "create_311_ticket",
            payload: { serviceCodeOrAction: "1.1.4.7.20.0" },
          },
        ],
        {
          env: { GNP_311_SUBMISSION_ENABLED: "true" },
          now,
          taskId: "task-1",
        },
      ),
    ).toEqual([
      {
        code: "create_311_ticket",
        status: "failed",
        reason: expect.stringContaining(
          "Missing required environment variable",
        ),
        payload: { serviceCodeOrAction: "1.1.4.7.20.0" },
        recordedAt: "2026-08-18T12:00:00.000Z",
      },
    ]);
  });

  it("leaves email and form integrations unconfigured", async () => {
    const results = await executeAppActions(
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
          status: "recorded",
          recordedAt: "2026-08-18T12:00:00.000Z",
        },
      ]),
    ).toBe("recorded");
  });
});
