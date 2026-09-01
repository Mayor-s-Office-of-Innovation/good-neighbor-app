import { describe, expect, it } from "vitest";

const {
  scrubClientErrorReport,
  stripQueryString,
  stripStackQueryStrings,
  MAX_MESSAGE,
  MAX_STACK,
} = await import("./scrub-client-error.js");

describe("scrubClientErrorReport", () => {
  it("keeps the allowlisted fields from a valid report", () => {
    const out = scrubClientErrorReport({
      type: "Error",
      message: "boom",
      stack: "Error: boom\n at f",
      source: "/check",
      release: "abc",
      id: "uuid-1",
      ts: "2026-08-31T10:00:00.000Z",
      // Non-allowlisted fields must be dropped:
      email: "a@b.c",
      token: "secret",
      location: { lat: 37.77, lng: -122.4 },
    });

    expect(out).toEqual({
      type: "Error",
      message: "boom",
      stack: "Error: boom\n at f",
      source: "/check",
      release: "abc",
      id: "uuid-1",
      ts: "2026-08-31T10:00:00.000Z",
    });
    expect(JSON.stringify(out)).not.toContain("a@b.c");
    expect(JSON.stringify(out)).not.toContain("secret");
    expect(JSON.stringify(out)).not.toContain("37.77");
  });

  it("rejects non-objects, arrays, and null", () => {
    expect(scrubClientErrorReport(null)).toBeNull();
    expect(scrubClientErrorReport("nope")).toBeNull();
    expect(scrubClientErrorReport(42)).toBeNull();
    expect(scrubClientErrorReport([])).toBeNull();
    expect(scrubClientErrorReport(undefined)).toBeNull();
  });

  it("rejects unknown types and missing required fields", () => {
    expect(
      scrubClientErrorReport({ type: "Warn", message: "x", id: "u" }),
    ).toBeNull();
    expect(scrubClientErrorReport({ type: "Error" })).toBeNull();
    expect(scrubClientErrorReport({ type: "Error", id: "u" })).toBeNull();
  });

  it("strips query strings from source", () => {
    const out = scrubClientErrorReport({
      type: "Error",
      message: "x",
      id: "u",
      source: "/check?a=1&token=secret",
    });
    expect(out?.source).toBe("/check");
  });

  it("strips query strings from URLs embedded in stack frames, keeps prose", () => {
    const out = scrubClientErrorReport({
      type: "Error",
      message: "x",
      id: "u",
      stack:
        "Error: boom\n    at f (https://cdn.example.com/app.js?token=secret:2:15)",
    });
    expect(out?.stack).toBe(
      "Error: boom\n    at f (https://cdn.example.com/app.js:2:15)",
    );
    expect(out?.stack).not.toContain("secret");
  });

  it("truncates oversized fields to the documented caps", () => {
    const out = scrubClientErrorReport({
      type: "Error",
      message: "m".repeat(99999),
      stack: "s".repeat(999999),
      id: "u".repeat(500),
      source: "x".repeat(999),
      release: "r".repeat(999),
    });

    expect(out?.message.length).toBe(MAX_MESSAGE);
    expect(out?.stack).toHaveLength(MAX_STACK);
    expect(out?.id.length).toBeLessThanOrEqual(200);
    expect(out?.source?.length).toBeLessThanOrEqual(500);
    expect(out?.release?.length).toBeLessThanOrEqual(200);
  });

  it("never throws on hostile input shapes", () => {
    const hostile = /** @type {unknown} */ (
      /** @type {any} */ ({
        get type() {
          throw new Error("getter bomb");
        },
      })
    );
    expect(scrubClientErrorReport(hostile)).toBeNull();
    expect(scrubClientErrorReport(42)).toBeNull();
  });
});

describe("stripQueryString", () => {
  it("strips ? and beyond; leaves bare paths alone", () => {
    expect(stripQueryString("/check?x=1")).toBe("/check");
    expect(stripQueryString("/check")).toBe("/check");
    expect(stripQueryString("")).toBe("");
  });
});

describe("stripStackQueryStrings", () => {
  it("scrubs only http(s) URLs, leaves relative paths and prose intact", () => {
    const stack =
      "Error: /assets/app.js?token=secret failed\n    at f (https://cdn.example.com/a.js?q=1:2:15)\n    at g (webpack:///./x.ts:3:5)";
    expect(stripStackQueryStrings(stack)).toBe(
      "Error: /assets/app.js?token=secret failed\n    at f (https://cdn.example.com/a.js:2:15)\n    at g (webpack:///./x.ts:3:5)",
    );
  });

  it("handles URLs terminated by ), whitespace, or end of line", () => {
    expect(stripStackQueryStrings("(https://x.dev/a.js?t=1)")).toBe(
      "(https://x.dev/a.js)",
    );
    expect(stripStackQueryStrings("https://x.dev/a.js?t=1 at f")).toBe(
      "https://x.dev/a.js at f",
    );
    expect(stripStackQueryStrings("at https://x.dev/a.js?t=1")).toBe(
      "at https://x.dev/a.js",
    );
  });

  it("leaves stacks without URLs untouched", () => {
    expect(stripStackQueryStrings("Error: boom\n at f")).toBe(
      "Error: boom\n at f",
    );
  });
});
