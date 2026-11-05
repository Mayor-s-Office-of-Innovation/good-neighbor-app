import { describe, expect, it } from "vitest";
import {
  publicContactState,
  responseDeadline,
  responseHours,
  responseState,
  severityBand,
  siteContactState,
} from "./indicators.js";

const CREATED = "2026-10-01T16:00:00.000Z";
const DEADLINE = "2026-10-04T16:00:00.000Z";
const AFTER = "2026-10-04T16:00:00.001Z";

/**
 * @param {string | null} firstResponseAt
 * @param {number} [hours]
 */
const issue = (firstResponseAt, hours = 72) => ({
  createdAt: CREATED,
  firstResponseAt,
  responded: Boolean(firstResponseAt),
  responseHours: hours,
});

describe("responseHours", () => {
  it("uses the window the task stored from its rule", () => {
    expect(
      responseHours({ ruleId: "LITTER-1", maxAcceptableResponseHours: 4 }),
    ).toBe(4);
  });

  it("keeps a stored 0, which the app reads as no overdue check", () => {
    expect(
      responseHours({ ruleId: "LITTER-1", maxAcceptableResponseHours: 0 }),
    ).toBe(0);
  });

  it("falls back to the current rule's window for an older task", () => {
    expect(responseHours({ ruleId: "BLOCK-1" })).toBe(4);
    expect(responseHours({ ruleId: "MED-1" })).toBe(0);
  });

  it("is 72 hours for a task whose rule sets no window", () => {
    expect(responseHours({})).toBe(72);
    expect(responseHours({ ruleId: "RETIRED-9" })).toBe(72);
    expect(
      responseHours({ ruleId: null, maxAcceptableResponseHours: null }),
    ).toBe(72);
  });

  it("ignores a stored window that isn't a usable number", () => {
    expect(
      responseHours({ ruleId: "BLOCK-1", maxAcceptableResponseHours: -1 }),
    ).toBe(4);
    expect(
      responseHours({ ruleId: "BLOCK-1", maxAcceptableResponseHours: "4" }),
    ).toBe(4);
  });
});

describe("responseDeadline", () => {
  it("is the rule's elapsed hours later, even across the fall-back", () => {
    expect(responseDeadline(CREATED, 72)).toBe(DEADLINE);
    expect(responseDeadline(CREATED, 4)).toBe("2026-10-01T20:00:00.000Z");
    expect(responseDeadline("2026-10-31T19:00:00.000Z", 72)).toBe(
      "2026-11-03T19:00:00.000Z",
    );
  });

  it("is null for a 0-hour rule", () => {
    expect(responseDeadline(CREATED, 0)).toBeNull();
  });

  it("is null for a creation time that does not parse", () => {
    expect(responseDeadline("soon", 72)).toBeNull();
  });
});

describe("responseState", () => {
  it.each([
    [
      "no response, before the deadline",
      "awaiting",
      null,
      "2026-10-02T00:00:00.000Z",
    ],
    ["no response, exactly at the deadline", "awaiting", null, DEADLINE],
    ["no response, just past the deadline", "overdue", null, AFTER],
    ["response exactly at the deadline", "onTime", DEADLINE, AFTER],
    [
      "response just after the deadline",
      "late",
      AFTER,
      "2026-10-09T00:00:00.000Z",
    ],
  ])("72 hours: %s is %s", (_name, state, firstResponseAt, evaluatedAt) => {
    expect(responseState(issue(firstResponseAt), evaluatedAt)).toBe(state);
  });

  it.each([
    ["exactly 4 hours", "2026-10-01T20:00:00.000Z", "onTime"],
    ["4 hours and 1 ms", "2026-10-01T20:00:00.001Z", "late"],
  ])("4-hour rule: a response after %s is %s", (_name, at, state) => {
    expect(responseState(issue(at, 4), DEADLINE)).toBe(state);
  });

  it.each([
    ["at", "2026-10-01T20:00:00.000Z", "awaiting"],
    ["1 ms past", "2026-10-01T20:00:00.001Z", "overdue"],
  ])("4-hour rule: no response %s the deadline is %s", (_n, at, state) => {
    expect(responseState(issue(null, 4), at)).toBe(state);
  });

  it.each([
    ["answered at once", "2026-10-01T16:00:00.000Z"],
    ["answered a week later", "2026-10-08T16:00:00.000Z"],
    ["never answered", null],
  ])("0-hour rule: %s is not timed", (_name, at) => {
    expect(responseState(issue(at, 0), "2026-10-09T00:00:00.000Z")).toBe(
      "notTimed",
    );
  });

  it("ignores a response made after the evaluation time", () => {
    expect(
      responseState(
        issue("2026-10-03T00:00:00.000Z"),
        "2026-10-02T00:00:00.000Z",
      ),
    ).toBe("awaiting");
  });

  it("is unknown when the record shows a response but not when", () => {
    expect(responseState({ ...issue(null), responded: true }, AFTER)).toBe(
      "unknown",
    );
  });

  it("is unknown when the response time is stored but unreadable", () => {
    expect(responseState(issue("bad"), AFTER)).toBe("unknown");
  });

  it("is unknown when the creation time is missing", () => {
    expect(responseState({ ...issue(null), createdAt: "" }, AFTER)).toBe(
      "unknown",
    );
  });
});

describe("severityBand", () => {
  it.each([
    [1, "minor"],
    [2, "minor"],
    [3, "moderate"],
    [4, "severe"],
    [5, "severe"],
    [0, "unknown"],
    [null, "unknown"],
    [2.5, "unknown"],
  ])("severity %s is %s", (severity, band) => {
    expect(severityBand(severity)).toBe(band);
  });
});

describe("publicContactState", () => {
  /** @param {Record<string, string>} publicContact */
  const pub = (publicContact) => publicContactState({ publicContact });

  it("is available with both a valid email and a valid phone", () => {
    expect(pub({ email: "desk@example.org", phone: "415-555-0100" })).toEqual({
      state: "available",
      reasonCodes: [],
    });
  });

  it("is missing with an email only", () => {
    expect(pub({ email: "desk@example.org", phone: "" })).toEqual({
      state: "missing",
      reasonCodes: ["no_phone"],
    });
  });

  it("is missing with a phone only", () => {
    expect(pub({ email: "", phone: "415-555-0100" })).toEqual({
      state: "missing",
      reasonCodes: ["no_email"],
    });
  });

  it("is missing with neither", () => {
    expect(pub({ email: " ", phone: "" })).toEqual({
      state: "missing",
      reasonCodes: ["no_email", "no_phone"],
    });
    expect(publicContactState({}).state).toBe("missing");
  });

  it("is missing when one field is blank, even if the other is invalid", () => {
    expect(pub({ email: "front desk", phone: "" })).toEqual({
      state: "missing",
      reasonCodes: ["invalid_email", "no_phone"],
    });
  });

  it.each([
    [
      "an invalid email",
      { email: "front desk", phone: "415-555-0100" },
      ["invalid_email"],
    ],
    [
      "an invalid phone",
      { email: "desk@example.org", phone: "12" },
      ["invalid_phone"],
    ],
    [
      "both invalid",
      { email: "not-an-email", phone: "12" },
      ["invalid_email", "invalid_phone"],
    ],
  ])("is unknown with %s and nothing blank", (_name, contact, reasonCodes) => {
    expect(pub(contact)).toEqual({ state: "unknown", reasonCodes });
  });

  it("is unknown without a Site record", () => {
    expect(publicContactState(null)).toEqual({
      state: "unknown",
      reasonCodes: ["no_site_record"],
    });
  });
});

describe("siteContactState", () => {
  /** @param {Record<string, string>} contact */
  const site = (contact) =>
    siteContactState({
      primaryContactUserId: "u1",
      primaryContact: { firstName: "Ana", ...contact },
    });

  it("is available for a designated contact with a valid email and phone", () => {
    expect(site({ email: "ana@example.org", phone: "415-555-0101" })).toEqual({
      state: "available",
      reasonCodes: [],
    });
  });

  it("is missing when the designated contact has an email only", () => {
    expect(site({ email: "ana@example.org", phone: "" })).toEqual({
      state: "missing",
      reasonCodes: ["no_phone"],
    });
  });

  it("is missing when the designated contact has a phone only", () => {
    expect(site({ email: "", phone: "415-555-0101" })).toEqual({
      state: "missing",
      reasonCodes: ["no_email"],
    });
  });

  it("is missing when no Site contact is designated", () => {
    expect(siteContactState({})).toEqual({
      state: "missing",
      reasonCodes: ["no_site_contact"],
    });
  });

  it("is unknown when the contact's stored phone fails the app's check", () => {
    expect(
      site({ email: "ana@example.org", phone: "(415) 555-0100 x12" }),
    ).toEqual({ state: "unknown", reasonCodes: ["invalid_phone"] });
  });

  it("is unknown without a Site record", () => {
    expect(siteContactState(null)).toEqual({
      state: "unknown",
      reasonCodes: ["no_site_record"],
    });
  });

  it("is unknown when a contact is designated but its copy is absent", () => {
    expect(siteContactState({ primaryContactUserId: "u1" })).toEqual({
      state: "unknown",
      reasonCodes: ["contact_copy_missing"],
    });
  });
});
