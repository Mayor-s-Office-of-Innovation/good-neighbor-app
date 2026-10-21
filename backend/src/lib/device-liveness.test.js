import { describe, expect, it } from "vitest";
import { deviceLivenessProblem } from "./device-liveness.js";

const now = new Date("2026-10-21T12:00:00.000Z");

describe("deviceLivenessProblem", () => {
  it("treats a missing item as a problem", () => {
    expect(deviceLivenessProblem(undefined, now)).toBe("missing");
    expect(deviceLivenessProblem(null, now)).toBe("missing");
  });

  it("accepts a legacy device with no status and no limits", () => {
    expect(deviceLivenessProblem({ deviceId: "d1" }, now)).toBeNull();
  });

  it("reports revoked and suspended status", () => {
    expect(deviceLivenessProblem({ status: "revoked" }, now)).toBe("revoked");
    expect(deviceLivenessProblem({ status: "suspended" }, now)).toBe(
      "suspended",
    );
    expect(deviceLivenessProblem({ status: "active" }, now)).toBeNull();
  });

  it("reports a passed absolute expiry", () => {
    expect(
      deviceLivenessProblem(
        { status: "active", absoluteExpiresAt: "2026-10-21T11:59:59.000Z" },
        now,
      ),
    ).toBe("expired");
    expect(
      deviceLivenessProblem(
        { status: "active", absoluteExpiresAt: "2026-10-21T12:00:01.000Z" },
        now,
      ),
    ).toBeNull();
  });

  it("reports inactivity past the limit, defaulting to 60 days", () => {
    const lastSeenAt = "2026-08-01T00:00:00.000Z";
    expect(deviceLivenessProblem({ lastSeenAt }, now)).toBe("inactive");
    expect(
      deviceLivenessProblem({ lastSeenAt, inactivityLimitDays: 365 }, now),
    ).toBeNull();
  });
});
