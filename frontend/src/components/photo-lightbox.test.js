import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeElement {}
class FakeHTMLElement extends FakeElement {}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("HTMLElement", FakeHTMLElement);
  vi.stubGlobal("customElements", { define: vi.fn() });
});

describe("photo-lightbox", () => {
  it("registers one reusable custom element", async () => {
    const { PhotoLightbox } = await import("./photo-lightbox.js");
    expect(customElements.define).toHaveBeenCalledWith(
      "photo-lightbox",
      PhotoLightbox,
    );
  });
});
