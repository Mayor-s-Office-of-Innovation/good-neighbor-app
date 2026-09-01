import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Tests for components/feedback-dialog.js.

  Node environment (repo default, no DOM — see today-view.test.js): the
  component's pure decision helpers are exercised directly, and the fetch-level
  behavior the dialog drives is covered via the real sendFeedback service
  (stubbed globals following error-report.test.js). DOM wiring (dialog open/
  close, pane toggling) is thin glue around these tested decisions.
*/

beforeEach(() => {
  // The component module extends HTMLElement at import time; the node env has
  // no DOM, so stub a minimal base class (today-view.test.js pattern).
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("customElements", { define: vi.fn() });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 204 }));
  vi.stubGlobal("location", { pathname: "/today" });
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
  });
  vi.stubGlobal("crypto", { randomUUID: () => "uuid-1" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("feedback-dialog pure decisions", () => {
  it("hasSendableText guards the send path", async () => {
    const { hasSendableText } = await import("./feedback-dialog.js");
    expect(hasSendableText("hello")).toBe(true);
    expect(hasSendableText("  spaced  ")).toBe(true);
    expect(hasSendableText("   ")).toBe(false);
    expect(hasSendableText("")).toBe(false);
    expect(hasSendableText(undefined)).toBe(false);
  });

  it("clearsDraft only when a send succeeded", async () => {
    const { clearsDraft } = await import("./feedback-dialog.js");
    expect(clearsDraft(true)).toBe(true);
    expect(clearsDraft(false)).toBe(false);
  });
});

describe("feedback-dialog → sendFeedback payload", () => {
  it("sends the trimmed message the dialog collects", async () => {
    const { sendFeedback } = await import("../services/feedback.js");
    await sendFeedback({ message: "  note from the sheet  " });

    const init = /** @type {any} */ (vi.mocked(fetch).mock.calls.at(-1)?.[1]);
    expect(JSON.parse(init.body)).toEqual(
      expect.objectContaining({
        message: "note from the sheet",
        page: "/today",
      }),
    );
  });
});
