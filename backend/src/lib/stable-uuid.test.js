import { describe, expect, it } from "vitest";
import { stableUuid } from "./stable-uuid.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("stableUuid", () => {
  it("is a version 5 uuid that depends only on the name", () => {
    const a = stableUuid("msg-1#0");
    expect(a).toMatch(UUID);
    expect(stableUuid("msg-1#0")).toBe(a);
    expect(stableUuid("msg-1#1")).not.toBe(a);
    expect(stableUuid("msg-2#0")).not.toBe(a);
  });
});
