import { describe, expect, it } from "vitest";
import { formatPhotoDateTime, photoLocation } from "./photo-lightbox.js";

describe("formatPhotoDateTime", () => {
  const now = new Date("2026-10-01T19:00:00Z");

  it("uses relative labels within the current Monday-based calendar week", () => {
    expect(formatPhotoDateTime("2026-10-01T18:59:00Z", now)).toBe(
      "Today, 11:59 AM",
    );
    expect(formatPhotoDateTime("2026-09-30T18:59:00Z", now)).toBe(
      "Yesterday, 11:59 AM",
    );
    expect(formatPhotoDateTime("2026-09-29T18:59:00Z", now)).toBe(
      "Tuesday, 11:59 AM",
    );
  });

  it("uses a numeric date before the current calendar week", () => {
    expect(formatPhotoDateTime("2026-09-27T18:59:00Z", now)).toBe(
      "09/27/2026, 11:59 AM",
    );
  });
});

describe("photoLocation", () => {
  it("prefers the first line of the georeferenced address", () => {
    expect(photoLocation("15th Street, San Francisco", "City Hall")).toBe(
      "15th Street",
    );
  });

  it("falls back to the first line of the site address", () => {
    expect(
      photoLocation("", "1 Dr Carlton B Goodlett Place\nSan Francisco"),
    ).toBe("1 Dr Carlton B Goodlett Place");
  });
});
