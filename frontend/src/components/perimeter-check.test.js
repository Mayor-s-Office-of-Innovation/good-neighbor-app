import { beforeAll, describe, expect, it, vi } from "vitest";

// Component registrations outlive mock call history between tests.
const components = new Map();

beforeAll(() => {
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("FileReader", { LOADING: 1 });
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  vi.stubGlobal("document", { addEventListener: vi.fn() });
  vi.stubGlobal("history", { pushState: vi.fn() });
  vi.stubGlobal("customElements", {
    define: (name, constructor) => components.set(name, constructor),
  });
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

  it("recovers legacy failed photos through the bounded retry policy", async () => {
    const { shouldResumeEvidenceItem } = await import("./perimeter-check.js");

    expect(
      shouldResumeEvidenceItem({
        kind: "photo",
        upload: { status: "failed" },
        analysis: { status: "failed" },
      }),
    ).toBe(true);
  });
});

describe("capture guidance cancellation", () => {
  it("aborts an outstanding guidance request when capture closes", async () => {
    await import("./perimeter-check.js");
    const component = components.get("perimeter-check");
    const abort = vi.fn();
    const stop = vi.fn();
    component.prototype.disconnectedCallback.call({
      _guidanceAbort: { abort },
      _stopElapsedTicker: stop,
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });
});
