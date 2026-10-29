import { describe, expect, it } from "vitest";
import {
  EVENTS,
  MAX_PROPERTY_STRING,
  scrubClientEvent,
  scrubProperties,
} from "./scrub-client-event.js";

describe("scrubClientEvent", () => {
  it("keeps the allowlisted shape and drops everything else", () => {
    const out = scrubClientEvent({
      event: "$pageview",
      id: "uuid-1",
      ts: "2026-10-06T10:00:00.000Z",
      release: "abc",
      properties: {
        $current_url: "https://app.example/today?code=SECRET#frag",
        $pathname: "/today",
        $screen_width: 412,
        ua_mobile: true,
        email: "a@b.c",
      },
      token: "secret",
    });
    expect(out).toEqual({
      event: "$pageview",
      id: "uuid-1",
      ts: "2026-10-06T10:00:00.000Z",
      release: "abc",
      properties: {
        $current_url: "https://app.example/today",
        $pathname: "/today",
        $screen_width: 412,
        ua_mobile: true,
      },
    });
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(JSON.stringify(out)).not.toContain("a@b.c");
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("accepts every allowlisted event name", () => {
    for (const event of EVENTS) {
      expect(scrubClientEvent({ event, id: "u" })?.event).toBe(event);
    }
  });

  it("rejects unknown events, missing ids, and non-objects", () => {
    expect(scrubClientEvent({ event: "$autocapture", id: "u" })).toBeNull();
    expect(scrubClientEvent({ event: "$pageview" })).toBeNull();
    expect(scrubClientEvent(null)).toBeNull();
    expect(scrubClientEvent([])).toBeNull();
    expect(scrubClientEvent("x")).toBeNull();
  });

  it("tolerates a missing or malformed properties bag", () => {
    expect(scrubClientEvent({ event: "camera_opened", id: "u" })).toEqual({
      event: "camera_opened",
      id: "u",
      properties: {},
    });
    expect(
      scrubClientEvent({ event: "camera_opened", id: "u", properties: [1] })
        ?.properties,
    ).toEqual({});
  });
});

describe("scrubProperties", () => {
  it("drops non-scalar values, non-finite numbers, and empty strings", () => {
    expect(
      scrubProperties({
        flow: { nested: true },
        device_memory_gb: NaN,
        hardware_concurrency: Infinity,
        route: "",
        $screen_height: 915,
        display_mode: "browser",
      }),
    ).toEqual({ $screen_height: 915, display_mode: "browser" });
  });

  it("caps long strings", () => {
    const long = "x".repeat(MAX_PROPERTY_STRING + 50);
    expect(scrubProperties({ device_model: long }).device_model).toHaveLength(
      MAX_PROPERTY_STRING,
    );
  });

  it("ignores prototype keys", () => {
    expect(scrubProperties(Object.create({ flow: "perimeter" }))).toEqual({});
  });
});

it("accepts bounded photo diagnostics and strips private or malformed fields", () => {
  const properties = {
    check_id: "11111111-1111-4111-8111-111111111111",
    attempt_id: "22222222-2222-4222-8222-222222222222",
    artifact_id: "https://example.test?signature=PRIVATE",
    stage: "put",
    outcome: "failed",
    elapsed_ms: 30000,
    http_status: 0,
    online: false,
    visibility: "hidden",
    upload_url: "PRIVATE",
    error: "PRIVATE",
  };
  const result = scrubClientEvent({
    event: "photo_pipeline",
    id: "device",
    properties,
  });
  expect(result?.properties).toEqual({
    check_id: properties.check_id,
    attempt_id: properties.attempt_id,
    stage: "put",
    outcome: "failed",
    elapsed_ms: 30000,
    http_status: 0,
    online: false,
    visibility: "hidden",
  });
  expect(
    scrubProperties({
      stage: "PRIVATE",
      outcome: "PRIVATE",
      elapsed_ms: -1,
      online: "PRIVATE",
    }),
  ).toEqual({});
});
