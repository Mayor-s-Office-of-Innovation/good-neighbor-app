import { describe, expect, it } from "vitest";
import { ApiError } from "./api.js";
import { submitErrorMessage } from "./submit-check.js";
import { t } from "../i18n/i18n.js";

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
    expect(start).toBe(t("error.submit.start.network"));
    expect(upload).toBe(t("error.submit.upload.network"));
    expect(start).not.toBe(upload);
  });

  it("splits cause within a leg: 409 conflict vs 5xx server on start", () => {
    const conflict = submitErrorMessage(tagged("start", { status: 409 }));
    const server = submitErrorMessage(tagged("start", { status: 500 }));
    expect(conflict).toBe(t("error.submit.start.conflict"));
    expect(server).toBe(t("error.submit.start.default"));
    expect(conflict).not.toBe(server);
  });

  it("maps a 413 upload to a photo-too-large message", () => {
    const msg = submitErrorMessage(tagged("upload", { status: 413 }));
    expect(msg).toBe(t("error.submit.upload.tooLarge"));
  });

  it("maps other 4xx uploads to a distinct 'rejected' message", () => {
    const msg = submitErrorMessage(tagged("upload", { status: 400 }));
    expect(msg).toBe(t("error.submit.upload.rejected"));
  });

  it("keeps the analyses-timeout message even though status is 0", () => {
    const msg = submitErrorMessage(
      tagged("analyze", { status: 0, body: { code: "analyses_pending" } }),
    );
    expect(msg).toBe(t("error.submit.analyze.pending"));
  });

  it("separates a network analyze drop from the timeout message", () => {
    const timeout = submitErrorMessage(
      tagged("analyze", { status: 0, body: { code: "analyses_pending" } }),
    );
    const dropped = submitErrorMessage(tagged("analyze", { status: 0 }));
    expect(dropped).toBe(t("error.submit.analyze.network"));
    expect(dropped).not.toBe(timeout);
  });

  it("distinguishes complete-phase network vs server failures", () => {
    const network = submitErrorMessage(tagged("complete", { status: 0 }));
    const server = submitErrorMessage(tagged("complete", { status: 500 }));
    expect(network).toBe(t("error.submit.complete.network"));
    expect(server).toBe(t("error.submit.complete.default"));
    expect(server).not.toBe(network);
  });

  it("falls back to a generic message for an untagged error", () => {
    const msg = submitErrorMessage(new Error("boom"));
    expect(msg).toBe(t("error.submit.generic"));
  });
});
