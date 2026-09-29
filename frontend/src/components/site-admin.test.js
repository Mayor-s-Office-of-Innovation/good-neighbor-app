import { describe, expect, it } from "vitest";

const {
  formatAdminDate,
  formatAdminPhone,
  validateContact,
  validateSiteDetails,
  valuesChanged,
} = await import("./site-admin.validation.js");

describe("site admin form decisions", () => {
  it("validates contact names, email, and US phone numbers", () => {
    expect(
      validateContact({
        firstName: "Priya",
        lastName: "Anand",
        email: "priya@example.org",
        phone: "(415) 555-0148",
      }),
    ).toBe("");
    expect(
      validateContact({
        firstName: "",
        lastName: "Anand",
        email: "not-an-email",
        phone: "123",
      }),
    ).toMatch(/First and last name/);
  });

  it("validates required site and address fields", () => {
    expect(
      validateSiteDetails({
        name: "Mission",
        address: {
          streetNumber: "1661",
          streetAddress: "15th St",
          city: "San Francisco",
          state: "CA",
          zip: "94103",
        },
      }),
    ).toBe("");
  });

  it("enables saves only when values change", () => {
    expect(valuesChanged({ name: "A" }, { name: "A" })).toBe(false);
    expect(valuesChanged({ name: "A" }, { name: "B" })).toBe(true);
  });

  it("formats letter dates for display", () => {
    expect(formatAdminDate("2026-01-15")).toBe("Jan 15, 2026");
    expect(formatAdminDate("")).toBe("Present");
  });

  it("formats valid US phone numbers consistently", () => {
    expect(formatAdminPhone("1234567789")).toBe("123-456-7789");
    expect(formatAdminPhone("(415) 555-0148")).toBe("415-555-0148");
    expect(formatAdminPhone("+1 415 555 0148")).toBe("415-555-0148");
  });
});
