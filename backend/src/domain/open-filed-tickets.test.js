import { describe, expect, it } from "vitest";
import { openFiledTicketNumbers } from "./open-filed-tickets.js";
import { canUpdateTask } from "./task-updates.js";

/** @param {Array<Record<string, unknown>>} tickets */
const filing = (tickets) => ({
  code: "create_311_ticket",
  status: "submitted",
  payload: { tickets },
});
/** @param {string} srNum @param {string} [status] */
const closure = (srNum, status = "closed") => ({
  code: "close_311_ticket",
  payload: { closures: [{ srNum, status }] },
});

describe("recorded open filing references", () => {
  it.each([
    [[], []],
    [[filing([])], []],
    [[filing([{}, { srNum: " " }, { srNum: false }])], []],
    [[filing([{ srNum: "123" }])], ["123"]],
    [[filing([{ srNum: "123" }]), closure("123")], []],
    [[filing([{ srNum: "123" }, { srNum: "456" }]), closure("123")], ["456"]],
    [[filing([{ srNum: "123" }]), closure("123", "failed")], ["123"]],
    [[filing([{ srNum: "123" }]), closure("other")], ["123"]],
    [[{ ...filing([{ srNum: "123" }]), status: "closed" }], []],
  ])(
    "reconciles filing and closure results: %j",
    (appActionResults, expected) => {
      const task = { appActionResults };
      expect(openFiledTicketNumbers(task)).toEqual(expected);
      expect(
        canUpdateTask({
          ...task,
          status: "completed",
          completionMethod: "311_filed",
        }),
      ).toBe(expected.length > 0);
      expect(
        canUpdateTask({
          ...task,
          status: "completing",
          completionLeaseExpiresAt: "2020-01-01T00:00:00Z",
        }),
      ).toBe(expected.length > 0);
      // Local work remains possible even when City help is no longer available.
      expect(canUpdateTask({ ...task, status: "in_progress" })).toBe(true);
    },
  );
  it("does not recover a site-team resolution or active claim", () => {
    const appActionResults = [filing([{ srNum: "123" }])];
    expect(
      canUpdateTask({
        appActionResults,
        status: "completed",
        completionMethod: "site_team_resolved",
      }),
    ).toBe(false);
    expect(
      canUpdateTask({
        appActionResults,
        status: "completing",
        completionLeaseExpiresAt: "2999-01-01T00:00:00Z",
      }),
    ).toBe(false);
  });
});
