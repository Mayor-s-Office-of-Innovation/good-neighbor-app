import { expect, it } from "vitest";
import { summarize311Recovery } from "./sf311-recovery-report.js";

it("separates historical failures and simulations without clearing silent failures", () => {
  const silent = {
    code: "create_311_ticket",
    payload: {
      executionTrigger: "task_created",
      serviceCodeOrAction: "Run graffiti analysis",
    },
  };
  const manual = {
    code: "create_311_ticket",
    payload: {
      executionTrigger: "user_confirmed",
      serviceCodeOrAction: "Run graffiti analysis",
    },
  };
  const historical = {
    code: "create_311_ticket",
    payload: { executionTrigger: "task_created", serviceCodeOrAction: "1.2.3" },
  };
  const report = summarize311Recovery([
    {
      sk: "TASK#one",
      taskId: "one",
      status: "in_progress",
      appActions: [silent, manual],
      appActionResults: [
        {
          ...silent,
          status: "failed",
          reason: "insufficient_classifier_information",
          diagnostics: { body: "private narrative" },
        },
        {
          ...manual,
          status: "submitted",
          payload: { ...manual.payload, tickets: [{ srNum: "SIM-example" }] },
        },
        { ...historical, status: "failed", reason: "missing_location" },
        {
          ...historical,
          payload: { ...historical.payload, serviceCodeOrAction: "1.2.4" },
          status: "failed",
          reason: "21",
        },
      ],
    },
    { sk: "SF311_JOB#one#created", status: "failed" },
    { sk: "SF311_JOB#two#resolved", status: "complete" },
  ]);
  expect(report).toMatchObject({
    tasksRead: 1,
    jobsRead: 2,
    tasksWithCurrentFailures: 1,
    tasksWithHistoricalFailures: 1,
    excludedCode21Results: 1,
    jobStatuses: { failed: 1, complete: 1 },
  });
  expect(report.failures).toHaveLength(2);
  expect(report.failures[0]).toMatchObject({
    filingType: "silent",
    applicability: "current_action",
    hasRecordedTicket: false,
  });
  expect(JSON.stringify(report)).not.toMatch(/private narrative|SIM-example/);
});

it("reports uncertain creations retained only in job checkpoints", () => {
  const action = {
    code: "create_311_ticket",
    payload: {
      executionTrigger: "task_created",
      serviceCodeOrAction: "Run graffiti analysis",
    },
  };
  const pending = {
    ...action,
    status: "partial",
    recordedAt: "2026-11-01T12:00:00Z",
    reason: "creation_pending",
    payload: {
      ...action.payload,
      tickets: [{ serviceCode: "1.5.1.1.18.0", creationState: "pending" }],
    },
  };
  const report = summarize311Recovery([
    {
      sk: "TASK#one",
      taskId: "one",
      status: "open",
      appActions: [action],
      appActionResults: [],
    },
    {
      sk: "SF311_JOB#one#created",
      taskId: "one",
      status: "retry",
      results: [pending],
    },
  ]);
  expect(report.failures).toHaveLength(1);
  expect(report.tasksWithCurrentFailures).toBe(1);
  expect(report.failures[0]).toMatchObject({
    taskId: "one",
    uncertainCreation: true,
    hasRecordedTicket: false,
  });
});

it("deduplicates stale pending job results after a task confirms submission", () => {
  const action = {
    code: "create_311_ticket",
    payload: {
      executionTrigger: "task_created",
      serviceCodeOrAction: "Run graffiti analysis",
    },
  };
  const report = summarize311Recovery([
    {
      sk: "TASK#one",
      taskId: "one",
      status: "open",
      appActions: [action],
      appActionResults: [
        {
          ...action,
          status: "submitted",
          recordedAt: "2026-11-01T12:01:00Z",
          payload: {
            ...action.payload,
            tickets: [{ serviceCode: "1.5.1.1.18.0", srNum: "synthetic-sr" }],
          },
        },
      ],
    },
    {
      sk: "SF311_JOB#one#created",
      taskId: "one",
      status: "retry",
      results: [
        {
          ...action,
          status: "partial",
          recordedAt: "2026-11-01T12:00:00Z",
          reason: "creation_pending",
          payload: {
            ...action.payload,
            tickets: [
              { serviceCode: "1.5.1.1.18.0", creationState: "pending" },
            ],
          },
        },
      ],
    },
  ]);
  expect(report.failures).toEqual([]);
});

it("keeps job-only failures visible even when their task is absent", () => {
  const report = summarize311Recovery([
    {
      sk: "SF311_JOB#missing#created",
      status: "retry",
      results: [
        {
          code: "create_311_ticket",
          status: "partial",
          reason: "creation_pending",
          payload: {
            tickets: [{ serviceCode: "1.2.3", creationState: "pending" }],
          },
        },
      ],
    },
  ]);
  expect(report.failures[0]).toMatchObject({
    taskId: "missing",
    taskStatus: "missing",
    applicability: "missing_task",
    uncertainCreation: true,
  });
});

it("does not let a newer rejection hide an earlier unconfirmed creation", () => {
  const payload = {
    executionTrigger: "task_created",
    serviceCodeOrAction: "Run graffiti analysis",
  };
  const report = summarize311Recovery([
    {
      sk: "TASK#one",
      taskId: "one",
      status: "open",
      appActions: [{ code: "create_311_ticket", payload }],
      appActionResults: [
        {
          code: "create_311_ticket",
          status: "failed",
          reason: "21",
          recordedAt: "2026-11-01T12:01:00Z",
          payload,
        },
      ],
    },
    {
      sk: "SF311_JOB#one#created",
      taskId: "one",
      status: "retry",
      results: [
        {
          code: "create_311_ticket",
          status: "partial",
          reason: "creation_pending",
          recordedAt: "2026-11-01T12:00:00Z",
          payload: {
            ...payload,
            tickets: [
              { serviceCode: "1.5.1.1.18.0", creationState: "pending" },
            ],
          },
        },
      ],
    },
  ]);
  expect(report.failures).toHaveLength(1);
  expect(report.code21Failures).toEqual([]);
  expect(report.excludedCode21Results).toBe(0);
  expect(report.failures[0]).toMatchObject({
    uncertainCreation: true,
    reason: "creation_pending",
  });
});

it("retains uncertain and partial creations as requiring investigation", () => {
  const action = {
    code: "create_311_ticket",
    payload: { executionTrigger: "user_confirmed" },
  };
  const report = summarize311Recovery([
    {
      sk: "TASK#one",
      taskId: "one",
      appActions: [action],
      appActionResults: [
        {
          ...action,
          status: "partial",
          reason: "creation_pending",
          payload: {
            ...action.payload,
            tickets: [{ creationState: "pending" }],
          },
        },
      ],
    },
  ]);
  expect(report.failures[0]).toMatchObject({
    uncertainCreation: true,
    filingType: "manual",
    applicability: "current_action",
  });
});

it("does not count a superseded task as a current failure", () => {
  const action = {
    code: "create_311_ticket",
    payload: { executionTrigger: "task_created" },
  };
  const report = summarize311Recovery([
    {
      sk: "TASK#old",
      taskId: "old",
      status: "superseded",
      appActions: [action],
      appActionResults: [
        {
          ...action,
          status: "failed",
          reason: "insufficient_classifier_information",
        },
      ],
    },
  ]);
  expect(report.tasksWithCurrentFailures).toBe(0);
  expect(report.tasksWithHistoricalFailures).toBe(1);
});

it.each(["21", "hub_21", 21])(
  "retains safe code-21 details for reason %s",
  (reason) => {
    const action = {
      code: "create_311_ticket",
      payload: {
        executionTrigger: "task_created",
        serviceCodeOrAction: "1.2.3",
      },
    };
    const result = {
      ...action,
      status: "partial",
      reason,
      recordedAt: "2026-11-01T12:00:00Z",
      payload: {
        ...action.payload,
        narrative: "private synthetic narrative",
        tickets: [
          {
            serviceCode: "1.2.3",
            srNum: "synthetic-ticket",
            mediaUrl: "private-media",
          },
        ],
      },
    };
    const report = summarize311Recovery([
      {
        sk: "TASK#current",
        taskId: "current",
        status: "open",
        appActions: [action],
        appActionResults: [result],
      },
      {
        sk: "SF311_JOB#current#created",
        taskId: "current",
        status: "failed",
        results: [result],
      },
      {
        sk: "TASK#old",
        taskId: "old",
        status: "superseded",
        appActions: [action],
        appActionResults: [result],
      },
      { sk: "SF311_JOB#missing#created", status: "failed", results: [result] },
    ]);
    expect(report.failures).toEqual([]);
    expect(report.excludedCode21Results).toBe(3);
    expect(report.tasksWithCurrentFailures).toBe(0);
    expect(report.tasksWithHistoricalFailures).toBe(0);
    expect(report.code21Failures).toEqual([
      expect.objectContaining({
        taskId: "current",
        applicability: "current_action",
        reason: "hub_21",
        hasRecordedTicket: true,
        uncertainCreation: false,
      }),
      expect.objectContaining({
        taskId: "old",
        applicability: "historical_action",
      }),
      expect.objectContaining({
        taskId: "missing",
        applicability: "missing_task",
      }),
    ]);
    expect(JSON.stringify(report)).not.toMatch(
      /private synthetic narrative|private-media|synthetic-ticket/,
    );
  },
);

it("removes a code-21 failure after a confirmed submission of the same action", () => {
  const payload = {
    executionTrigger: "task_created",
    serviceCodeOrAction: "1.2.3",
  };
  const report = summarize311Recovery([
    {
      sk: "SF311_JOB#one#created",
      results: [
        {
          code: "create_311_ticket",
          payload,
          status: "failed",
          reason: "hub_21",
          recordedAt: "2026-11-01T12:00:00Z",
        },
      ],
    },
    {
      sk: "TASK#one",
      taskId: "one",
      appActionResults: [
        {
          code: "create_311_ticket",
          payload: {
            ...payload,
            tickets: [{ serviceCode: "1.2.3", srNum: "synthetic-ticket" }],
          },
          status: "submitted",
          recordedAt: "2026-11-01T12:01:00Z",
        },
      ],
    },
  ]);
  expect(report.code21Failures).toEqual([]);
  expect(report.excludedCode21Results).toBe(0);
});
