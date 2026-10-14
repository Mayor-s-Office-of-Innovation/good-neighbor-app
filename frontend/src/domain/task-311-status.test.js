import { describe, expect, it } from "vitest";
import {
  map311StatusResponse,
  submitted311Requests,
  taskWith311Status,
} from "./task-311-status.js";

const filed = {
  taskId: "t1",
  createdAt: "2026-09-29T16:10:00.000Z",
  appActionResults: [
    { code: "create_311_ticket", payload: { tickets: [{ srNum: "SR-9" }] } },
  ],
};
const plain = { taskId: "t2", createdAt: "2026-09-29T16:10:00.000Z" };

describe("task-311-status", () => {
  it("asks only about tasks with a submitted ticket", () => {
    expect(submitted311Requests([filed, plain, { taskId: "" }])).toEqual([
      { taskId: "t1", srNum: "SR-9" },
    ]);
  });

  it("indexes the batch response by task and ignores empty statuses", () => {
    const map = map311StatusResponse({
      requests: [
        {
          taskId: "t1",
          request: {
            status: "Open",
            statusDetail: "Assigned",
            responseOverdue: true,
            relevantDate: "2026-09-30T00:00:00.000Z",
          },
        },
        { taskId: "t3", request: {} },
      ],
    });
    expect([...map.keys()]).toEqual(["t1"]);
    expect(map.get("t1")).toEqual({
      status: "Open",
      statusDetail: "Assigned",
      responseOverdue: true,
      updatedAt: "2026-09-30T00:00:00.000Z",
    });
    expect(map311StatusResponse(null).size).toBe(0);
  });

  it("stamps card-facing ticket fields, defaulting when the status is unknown", () => {
    const map = map311StatusResponse({
      requests: [{ taskId: "t1", request: { status: "Closed" } }],
    });
    expect(taskWith311Status(filed, map)).toMatchObject({
      ticketStatus: "Closed",
      ticketStatusDetail: "",
      ticketResponseOverdue: false,
      ticketUpdatedAt: filed.createdAt,
    });
    expect(taskWith311Status(filed, new Map()).ticketStatus).toBe("");
    expect(taskWith311Status(plain, map)).toBe(plain);
  });
});
