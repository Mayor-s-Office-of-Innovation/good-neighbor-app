import { describe, expect, it } from "vitest";
import { publicContactState, siteContactState } from "./indicators.js";

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
