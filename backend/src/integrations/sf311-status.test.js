import { describe, expect, it } from "vitest";
import {
  findServiceRequest,
  normalizeSf311Detail,
  serviceRequestClosureState,
  serviceRequestClosureReason,
} from "./sf311-status.js";

describe("SF311 status normalization", () => {
  it("distinguishes closed, open, and unknown records for safe retries", () => {
    expect(
      serviceRequestClosureState(
        { requests: [{ SRNum: "123", Status: "4" }] },
        "123",
      ),
    ).toBe("closed");
    expect(
      serviceRequestClosureState(
        { requests: [{ SRNum: "123", Status: "5" }] },
        "123",
      ),
    ).toBe("open");
    expect(serviceRequestClosureState({ requests: [] }, "123")).toBe("unknown");
  });

  it("reads the latest closure reason without inventing missing reasons", () => {
    const body = {
      requests: [
        {
          SRNum: "123",
          ClosedReasonCode: "1",
          Updates: [
            {
              UpdateType: "11",
              NumericSubType: "8",
              EffectiveDate: "2026-09-20T14:00:00Z",
            },
            {
              UpdateType: "11",
              NumericSubType: "2",
              EffectiveDate: "2026-09-20T12:00:00Z",
            },
          ],
        },
      ],
    };
    expect(serviceRequestClosureReason(body, "123")).toBe("8");
    expect(
      serviceRequestClosureReason(
        { requests: [{ SRNum: "123", ClosedReasonCode: 2 }] },
        "123",
      ),
    ).toBe("2");
    expect(
      serviceRequestClosureReason(
        { requests: [{ SRNum: "123", Status: "4" }] },
        "123",
      ),
    ).toBe("");
    expect(serviceRequestClosureReason(body, "missing")).toBe("");
  });

  it("returns human-readable updates newest first and omits attachment events", () => {
    const record = findServiceRequest(
      {
        data: {
          requests: [
            {
              SRNum: "123",
              Status: "5",
              ResponsibleAgency: "31",
              SourceAgencyReceiveDate: "2026-09-20T12:00:00Z",
              Updates: [
                {
                  UpdateType: "14",
                  NumericSubType: "31",
                  EffectiveDate: "2026-09-20T13:00:00Z",
                },
                {
                  UpdateType: "8",
                  TextSubType: "private",
                  EffectiveDate: "2026-09-20T14:00:00Z",
                },
                { UpdateType: "6", EffectiveDate: "2026-09-20T15:00:00Z" },
              ],
            },
          ],
        },
      },
      "123",
    );
    expect(record).not.toBeNull();
    const detail = normalizeSf311Detail({
      record: /** @type {Record<string, unknown>} */ (record),
      srNum: "123",
      now: new Date("2026-09-20T16:00:00Z"),
      task: {
        userFriendlyLabel: "Blocked sidewalk",
        maxAcceptableResponseHours: 12,
      },
    });
    expect(detail).toMatchObject({
      status: "In progress",
      responseOverdue: false,
      problemType: "Blocked sidewalk",
      assignedAgency: "San Francisco Police Department (SFPD)",
    });
    expect(detail.events.map((event) => event.title)).toEqual([
      "Work has been completed on this ticket",
      "San Francisco Police Department (SFPD) has received this ticket and is reviewing",
      "Ticket submitted",
    ]);
  });

  it("computes overdue and closure states", () => {
    const base = {
      SRNum: "123",
      SourceAgencyReceiveDate: "2026-09-20T12:00:00Z",
    };
    /** @param {Record<string, unknown>} record @param {Record<string, unknown>} [task] */
    const normalize = (record, task = {}) =>
      normalizeSf311Detail({
        record,
        srNum: "123",
        task,
        now: new Date("2026-09-20T17:00:00Z"),
      });
    expect(normalize(base, { maxAcceptableResponseHours: 4 })).toMatchObject({
      status: "Open",
      statusDetail: "response overdue",
      responseOverdue: true,
    });
    expect(
      normalize({ ...base, Status: "4", ClosedReason: "8" }),
    ).toMatchObject({
      status: "Closed",
      statusDetail: "field work completed",
      responseOverdue: false,
      closureReason: "Field Work Completed",
    });
    expect(
      normalize({ ...base, Status: "4", ClosedReason: "2" }),
    ).toMatchObject({
      status: "Closed",
      statusDetail: "duplicate",
      closureReason: "Duplicate",
    });
    expect(
      normalize(base, { maxAcceptableResponseHours: 0 }),
    ).not.toHaveProperty("expectedResponseAt");
  });

  it("uses the most recent dated status update instead of a stale summary status", () => {
    const detail = normalizeSf311Detail({
      record: {
        SRNum: "123",
        Status: "9",
        SourceAgencyReceiveDate: "2026-09-20T12:00:00Z",
        Updates: [
          {
            UpdateType: "3",
            NumericSubType: "7",
            EffectiveDate: "2026-09-20T13:00:00Z",
          },
          {
            UpdateType: "3",
            NumericSubType: "6",
            EffectiveDate: "2026-09-20T14:00:00Z",
          },
        ],
      },
      srNum: "123",
      task: {},
      now: new Date("2026-09-20T16:00:00Z"),
    });

    expect(detail).toMatchObject({
      status: "On hold",
      responseOverdue: false,
    });
    expect(detail).not.toHaveProperty("statusDetail");
  });

  it("puts the closure reason and agency note below the resolved title", () => {
    const detail = normalizeSf311Detail({
      record: {
        SRNum: "123",
        Status: "4",
        SourceAgencyReceiveDate: "2026-09-20T12:00:00Z",
        Updates: [
          {
            UpdateType: "11",
            NumericSubType: "8",
            Notes: "Removed the debris.",
            EffectiveDate: "2026-09-20T15:00:00Z",
          },
        ],
      },
      srNum: "123",
      task: {},
      now: new Date("2026-09-20T16:00:00Z"),
    });

    expect(detail.events[0]).toMatchObject({
      title: "The ticket was resolved",
      description: "Agency said: Field Work Completed\nRemoved the debris.",
    });
  });
});

it("passes through Verint closure codes without inventing a reason from notes", () => {
  const detail = normalizeSf311Detail({
    record: { Status: "4", ClosedReason: "999" },
    task: {},
    srNum: "123",
  });
  expect(detail.closedReason).toBe("999");
  expect(detail.closureReason).toBeUndefined();
  const unknown = normalizeSf311Detail({
    record: { Status: "4", Notes: "Closed by agency" },
    task: {},
    srNum: "123",
  });
  expect(unknown.closedReason).toBeUndefined();
});

describe("City closure timeline completeness", () => {
  const normalize = (/** @type {Record<string, unknown>} */ record) =>
    normalizeSf311Detail({ record, task: {}, srNum: "123" });
  it("keeps summary-only closure undated rather than using submission or refresh time", () => {
    const detail = normalize({
      Status: "4",
      SourceAgencyReceiveDate: "2026-10-01T12:00:00Z",
    });
    expect(detail.status).toBe("Closed");
    expect(detail.events.filter((e) => e.kind === "resolved")).toEqual([
      { kind: "resolved", title: "The ticket was resolved", occurredAt: "" },
    ]);
  });
  it.each([undefined, "999", "8"])(
    "preserves dated closure with reason %s without duplication",
    (reason) => {
      const detail = normalize({
        Status: "4",
        Updates: [
          {
            UpdateType: "11",
            NumericSubType: reason,
            EffectiveDate: "2026-10-02T12:00:00Z",
          },
        ],
      });
      expect(detail.events.filter((e) => e.kind === "resolved")).toHaveLength(
        1,
      );
      expect(detail.events[0].occurredAt).toBe("2026-10-02T12:00:00.000Z");
    },
  );
  it("keeps an undated unrecognized closure without a fabricated reason", () => {
    const detail = normalize({
      Updates: [{ UpdateType: "11", NumericSubType: "999" }],
    });
    expect(detail.status).toBe("Closed");
    expect(detail.events).toHaveLength(1);
    expect(detail.events[0]).toMatchObject({
      kind: "resolved",
      occurredAt: "",
    });
    expect(detail.events[0]).not.toHaveProperty("closureReason");
  });
  it("does not duplicate a Closed status-change event", () => {
    const detail = normalize({
      Status: "4",
      Updates: [
        {
          UpdateType: "3",
          NumericSubType: "4",
          EffectiveDate: "2026-10-02T12:00:00Z",
        },
      ],
    });
    expect(detail.events).toHaveLength(1);
    expect(detail.events[0]).toMatchObject({
      kind: "statusChanged",
      value: "Closed",
    });
  });
  it("does not synthesize a closure for an open ticket", () => {
    expect(normalize({ Status: "9" }).events).toEqual([]);
  });
});

describe("attachment reconciliation", () => {
  it("requires the same ticket, attachment type, and exact media URL", async () => {
    const { hasServiceRequestAttachment } = await import("./sf311-status.js");
    const { createHash } = await import("node:crypto");
    const url = "https://media.example/photo?token=one";
    const hash = createHash("sha256").update(url).digest("hex");
    const body = {
      SRNum: "123",
      Updates: [{ UpdateType: "8", TextSubType: url }],
    };
    expect(hasServiceRequestAttachment(body, "123", hash)).toBe(true);
    expect(hasServiceRequestAttachment(body, "456", hash)).toBe(false);
    expect(
      hasServiceRequestAttachment(
        { ...body, Updates: [{ UpdateType: "14", TextSubType: url }] },
        "123",
        hash,
      ),
    ).toBe(false);
    expect(
      hasServiceRequestAttachment(
        { ...body, Updates: [{ UpdateType: "8", TextSubType: url + "other" }] },
        "123",
        hash,
      ),
    ).toBe(false);
  });
});
