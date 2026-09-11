import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Finding 1 (PR review 192): a describe-only single-problem report used to be
// stored on place.description, which the capture-complete Done path never
// counted or uploaded — the report was silently dropped. Continue now converts
// the description into a kind:"text" item and runs it through the same
// incremental pipeline as photos.

const addItem = vi.fn(() => ({ id: "item-1" }));
const updateItem = vi.fn();
const getFlowType = vi.fn(() => "single-problem");
const getPlaceDescription = vi.fn(() => null);
const setPlaceDescription = vi.fn();
const setPostDescribeAction = vi.fn();
const analyzeEvidenceItem = vi.fn();
const navigate = vi.fn();

vi.mock("../state/check-session.js", () => ({
  addItem,
  updateItem,
  getFlowType,
  getCurrentCheck: vi.fn(() => null),
  loadDraft: vi.fn(async () => null),
  getActivePlaceIndex: vi.fn(() => 0),
  getPlaceOrder: vi.fn(() => ["place-1"]),
  getPlaceDescription,
  setPlaceDescription,
  setPostDescribeAction,
}));

vi.mock("../services/photo-analysis.js", () => ({
  analyzeEvidenceItem,
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

/** _onContinue is pure session/service wiring — build the instance directly. */
async function buildDescribeInstead({ flowType = "single-problem" } = {}) {
  getFlowType.mockReturnValue(flowType);
  await import("./describe-instead.js");
  const define = /** @type {any} */ (globalThis.customElements).define;
  const DescribeInstead = define.mock.calls.find(
    ([name]) => name === "describe-instead",
  )?.[1];
  if (!DescribeInstead) throw new Error("describe-instead was not registered");
  const element = Object.create(DescribeInstead.prototype);
  element._flowType = flowType;
  element._placeId = "place-1";
  element._placeIndex = 0;
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
    expect(setPlaceDescription).not.toHaveBeenCalled();
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

  it("keeps the place-description path for perimeter describe", async () => {
    const element = await buildDescribeInstead({ flowType: "perimeter" });
    element._text = "Yard looks fine.";

    await element._onContinue();

    expect(setPlaceDescription).toHaveBeenCalledWith("place-1", {
      kind: "note",
      text: "Yard looks fine.",
      source: "typed",
      validated: true,
      validation: { whatYouCanSee: true, whereItIs: true },
    });
    expect(addItem).not.toHaveBeenCalled();
    expect(analyzeEvidenceItem).not.toHaveBeenCalled();
    expect(setPostDescribeAction).toHaveBeenCalledWith({
      type: "stay",
      placeIndex: 0,
    });
    expect(navigate).toHaveBeenCalledWith("/check");
  });
});
