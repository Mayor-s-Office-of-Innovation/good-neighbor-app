import { describe, expect, it } from "vitest";

import { t } from "../i18n/i18n.js";

const {
  formatAdminDate,
  formatCountdown,
  formatDeviceEnrollmentSummary,
  formatAdminPhone,
  validateContact,
  validateSiteDetails,
  valuesChanged,
} = await import("./site-admin.validation.js");

describe("site admin device summary", () => {
  it("prompts enrollment when no active devices exist", () => {
    expect(formatDeviceEnrollmentSummary([{ status: "revoked" }])).toBe(
      'Click "Manage" to enroll new team member devices.',
    );
  });

  it("uses singular grammar for one active device", () => {
    expect(formatDeviceEnrollmentSummary([{ status: "active" }])).toBe(
      '1 device is enrolled. Click "Manage" to revoke access or add new devices.',
    );
  });

  it("counts only active devices in the plural summary", () => {
    expect(
      formatDeviceEnrollmentSummary([
        { status: "active" },
        { status: "revoked" },
        { status: "active" },
      ]),
    ).toBe(
      '2 devices are enrolled. Click "Manage" to revoke access or add new devices.',
    );
  });
});

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
    ).toBe(t("siteAdmin.validation.nameRequired"));
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
    expect(formatAdminDate("")).toBe(t("siteAdmin.datePresent"));
  });

  it("formats valid US phone numbers consistently", () => {
    expect(formatAdminPhone("1234567789")).toBe("123-456-7789");
    expect(formatAdminPhone("(415) 555-0148")).toBe("415-555-0148");
    expect(formatAdminPhone("+1 415 555 0148")).toBe("415-555-0148");
  });
});

it.each([
  [0, "minutes", 0],
  [59, "minutes", 59],
  [60, "hours", 1],
  [479, "hours", 7],
  [1439, "hours", 23],
  [1440, "days", 1],
  [3000, "days", 2],
])("formats %i minutes rounded down", (minutes, unit, count) => {
  expect(formatCountdown(minutes * 60000)).toBe(
    t(`access.duration.${unit}`, { count }),
  );
});
