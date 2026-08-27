import { describe, expect, it } from "vitest";
import { ApiError } from "./api.js";
import { submitErrorMessage } from "./submit-check.js";

/** Build an ApiError with the failing-leg tag `withLeg` would have stamped. */
function tagged(leg, { status = 0, body = undefined } = {}) {
  const err = new ApiError(`test ${leg}`, { status, body });
  /** @type {any} */ (err).leg = leg;
  return err;
}

describe("submitErrorMessage", () => {
  it("distinguishes the two foreground legs on a network drop", () => {
    const start = submitErrorMessage(tagged("start", { status: 0 }));
    const upload = submitErrorMessage(tagged("upload", { status: 0 }));
    expect(start).toContain("start this check");
    expect(upload).toContain("upload your photos");
    expect(start).not.toBe(upload);
  });

  it("splits cause within a leg: 409 conflict vs 5xx server on start", () => {
    const conflict = submitErrorMessage(tagged("start", { status: 409 }));
    const server = submitErrorMessage(tagged("start", { status: 500 }));
    expect(conflict).toContain("already have been filed");
    expect(server).toContain("on our end");
    expect(conflict).not.toBe(server);
  });

  it("maps a 413 upload to a photo-too-large message", () => {
    const msg = submitErrorMessage(tagged("upload", { status: 413 }));
    expect(msg).toContain("too large");
  });

  it("maps other 4xx uploads to a distinct 'rejected' message", () => {
    const msg = submitErrorMessage(tagged("upload", { status: 400 }));
    expect(msg).toContain("rejected one of your photos");
  });

  it("keeps the analyses-timeout message even though status is 0", () => {
    const msg = submitErrorMessage(
      tagged("analyze", { status: 0, body: { code: "analyses_pending" } }),
    );
    expect(msg).toContain("taking longer than expected");
  });

  it("separates a network analyze drop from the timeout message", () => {
    const timeout = submitErrorMessage(
      tagged("analyze", { status: 0, body: { code: "analyses_pending" } }),
    );
    const dropped = submitErrorMessage(tagged("analyze", { status: 0 }));
    expect(dropped).toContain("Lost connection");
    expect(dropped).not.toBe(timeout);
  });

  it("distinguishes complete-phase network vs server failures", () => {
    const network = submitErrorMessage(tagged("complete", { status: 0 }));
    const server = submitErrorMessage(tagged("complete", { status: 500 }));
    expect(network).toContain("connection dropped");
    expect(server).not.toBe(network);
  });

  it("has a dedicated message for a missing assessment", () => {
    const err = new Error("Check completed without an assessment to evaluate.");
    /** @type {any} */ (err).leg = "assessment";
    expect(submitErrorMessage(err)).toContain("results couldn’t be read");
  });

  it("falls back to a generic message for an untagged error", () => {
    const msg = submitErrorMessage(new Error("boom"));
    expect(msg).toContain("Couldn’t file this check");
  });

  it("uses a leg's default when the cause is unmapped for that leg", () => {
    // 'assessment' has only a default; any cause resolves to it.
    const msg = submitErrorMessage(tagged("assessment", { status: 500 }));
    expect(msg).toContain("results couldn’t be read");
  });
});
