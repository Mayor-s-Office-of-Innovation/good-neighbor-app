import { beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  vi.stubGlobal("document", { addEventListener: vi.fn() });
  vi.stubGlobal("history", { pushState: vi.fn() });
  vi.stubGlobal("customElements", { define: vi.fn() });
});

describe("shouldResumeEvidenceItem", () => {
  it("retries failed text evidence before an artifact id exists", async () => {
    const { shouldResumeEvidenceItem } = await import("./perimeter-check.js");

    expect(
      shouldResumeEvidenceItem({
        kind: "text",
        upload: { status: "failed" },
        analysis: { status: "failed" },
      }),
    ).toBe(true);
  });

  it("retries failed evidence with an uploaded artifact id", async () => {
    const { shouldResumeEvidenceItem } = await import("./perimeter-check.js");

    expect(
      shouldResumeEvidenceItem({
        kind: "photo",
        upload: { status: "uploaded", artifactId: "artifact-1" },
        analysis: { status: "failed" },
      }),
    ).toBe(true);
  });

  it("does not retry failed photos before upload succeeds", async () => {
    const { shouldResumeEvidenceItem } = await import("./perimeter-check.js");

    expect(
      shouldResumeEvidenceItem({
        kind: "photo",
        upload: { status: "failed" },
        analysis: { status: "failed" },
      }),
    ).toBe(false);
  });
});

describe("findReviewTextButton", () => {
  it("finds the save button for place ids that are not selector-safe", async () => {
    const { findReviewTextButton } = await import("./perimeter-check.js");
    const matching = {
      getAttribute: (name) =>
        name === "data-review-text" ? 'place["north"]' : null,
    };
    const root = {
      querySelectorAll: () => [{ getAttribute: () => "place-south" }, matching],
    };

    expect(findReviewTextButton(root, 'place["north"]')).toBe(matching);
  });
});
