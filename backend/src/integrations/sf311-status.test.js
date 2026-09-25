import { describe, expect, it } from "vitest";
import { findServiceRequest, normalizeSf311Detail } from "./sf311-status.js";

describe("SF311 status normalization", () => {
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
