import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Text evidence is the alternative to photos (docs/plan-remove-places.md):
// Continue files the typed text as a kind:"text" item through the same
// incremental pipeline as photos for BOTH flows. The perimeter check keeps one
// description per check — saving a changed description replaces the old item.

const addItem = vi.fn(() => ({ id: "item-1" }));
const updateItem = vi.fn();
const getFlowType = vi.fn(() => "single-problem");
const analyzeEvidenceItem = vi.fn();
const removeEvidenceItem = vi.fn(async () => {});
const navigate = vi.fn();

vi.mock("../state/check-session.js", () => ({
  addItem,
  updateItem,
  getFlowType,
  getCurrentCheck: vi.fn(() => null),
  getCapturePlaceId: vi.fn(() => "place-1"),
  loadDraft: vi.fn(async () => null),
}));

vi.mock("../services/photo-analysis.js", () => ({
  analyzeEvidenceItem,
  removeEvidenceItem,
}));

vi.mock("../router.js", () => ({
  currentRoute: vi.fn(() => "/problem/describe"),
  navigate,
}));

vi.mock("../db.js", () => ({
  getSite: vi.fn(async () => ({ siteId: "site-1", name: "Test site" })),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("customElements", { define: vi.fn() });
  vi.stubGlobal("crypto", { randomUUID: () => "uuid-1" });
  vi.stubGlobal("location", { pathname: "/problem/describe" });
  vi.stubGlobal("history", { pushState: vi.fn() });
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  vi.stubGlobal("document", { addEventListener: vi.fn() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const LONG_TEXT =
  "Sidewalks are clear on both sides. There is litter near the entrance.";

/** _onContinue is pure session/service wiring — build the instance directly. */
async function buildDescribeInstead({
  flowType = "single-problem",
  existing = null,
} = {}) {
  getFlowType.mockReturnValue(flowType);
  await import("./describe-instead.js");
  const { MIN_DESCRIPTION_LENGTH, MIN_TEXT_EVIDENCE_LENGTH } = await import(
    "../domain/check-completion.js"
  );
  const define = /** @type {any} */ (globalThis.customElements).define;
  const DescribeInstead = define.mock.calls.find(
    ([name]) => name === "describe-instead",
  )?.[1];
  if (!DescribeInstead) throw new Error("describe-instead was not registered");
  const element = Object.create(DescribeInstead.prototype);
  element._flowType = flowType;
  element._placeId = "place-1";
  element._minLength =
    flowType === "perimeter"
      ? MIN_DESCRIPTION_LENGTH
      : MIN_TEXT_EVIDENCE_LENGTH;
  element._existing = existing;
  element._savedText = existing?.text || "";
  element._routeBase = flowType === "single-problem" ? "/problem" : "/check";
  return element;
}

describe("describe-instead (single-problem)", () => {
  it("converts the description into a text item and analyzes it on Continue", async () => {
    const element = await buildDescribeInstead();
    element._text = "There is a pothole by the north entrance.";

    await element._onContinue();

    expect(addItem).toHaveBeenCalledWith("place-1", {
      kind: "text",
      text: "There is a pothole by the north entrance.",
    });
    expect(updateItem).toHaveBeenCalledWith("place-1", "item-1", {
      upload: { status: "uploaded" },
    });
    expect(analyzeEvidenceItem).toHaveBeenCalledWith("place-1", "item-1");
    expect(removeEvidenceItem).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/problem");
  });

  it("does nothing when the text is blank", async () => {
    const element = await buildDescribeInstead();
    element._text = "   ";

    await element._onContinue();

    expect(addItem).not.toHaveBeenCalled();
    expect(analyzeEvidenceItem).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("refuses a note below the analyzer's 5-character text minimum", async () => {
    // The backend rejects text artifacts under 5 chars permanently — the
    // single-problem flow must not file one (perimeter uses its own 20-char
    // minimum, covered in the describe block below).
    const element = await buildDescribeInstead();
    element._text = "hi";

    await element._onContinue();

    expect(addItem).not.toHaveBeenCalled();
    expect(analyzeEvidenceItem).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("describe-instead (perimeter)", () => {
  it("files the description as text evidence through the photo pipeline", async () => {
    const element = await buildDescribeInstead({ flowType: "perimeter" });
    element._text = LONG_TEXT;

    await element._onContinue();

    expect(addItem).toHaveBeenCalledWith("place-1", {
      kind: "text",
      text: LONG_TEXT,
    });
    expect(analyzeEvidenceItem).toHaveBeenCalledWith("place-1", "item-1");
    expect(navigate).toHaveBeenCalledWith("/check");
  });

  it("refuses a description shorter than the minimum", async () => {
    const element = await buildDescribeInstead({ flowType: "perimeter" });
    element._text = "Looks fine.";

    await element._onContinue();

    expect(addItem).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("replaces the saved description instead of adding a second one", async () => {
    const element = await buildDescribeInstead({
      flowType: "perimeter",
      existing: { id: "old-text", placeId: "place-1", text: LONG_TEXT },
    });
    element._text = `${LONG_TEXT} Graffiti on the side wall.`;

    await element._onContinue();

    // The old text was already a registered artifact: replacement deletes it
    // server-side via removeEvidenceItem before the new item is filed.
    expect(removeEvidenceItem).toHaveBeenCalledWith("place-1", "old-text");
    expect(addItem).toHaveBeenCalledWith("place-1", {
      kind: "text",
      text: `${LONG_TEXT} Graffiti on the side wall.`,
    });
    expect(analyzeEvidenceItem).toHaveBeenCalledWith("place-1", "item-1");
    expect(navigate).toHaveBeenCalledWith("/check");
  });

  it("does not half-apply a replacement when the server delete fails", async () => {
    // If the stale artifact survives server-side and the new one is filed
    // anyway, completeCheck would fold BOTH descriptions into the scorecard.
    removeEvidenceItem.mockRejectedValueOnce(new Error("delete failed"));
    const element = await buildDescribeInstead({
      flowType: "perimeter",
      existing: { id: "old-text", placeId: "place-1", text: LONG_TEXT },
    });
    element._text = `${LONG_TEXT} Graffiti on the side wall.`;

    await element._onContinue();

    expect(addItem).not.toHaveBeenCalled();
    expect(analyzeEvidenceItem).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("leaves an unchanged description alone and just returns", async () => {
    const element = await buildDescribeInstead({
      flowType: "perimeter",
      existing: { id: "old-text", placeId: "place-1", text: LONG_TEXT },
    });
    element._text = `  ${LONG_TEXT}  `;

    await element._onContinue();

    expect(removeEvidenceItem).not.toHaveBeenCalled();
    expect(addItem).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/check");
  });
});
