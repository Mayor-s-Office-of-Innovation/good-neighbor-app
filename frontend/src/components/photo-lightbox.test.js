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

  it("ignores a trigger whose screen was replaced before the lazy import resolved", async () => {
    const { openPhotoLightbox } = await import("./photo-lightbox.js");
    const host = {
      isConnected: true,
      contains: vi.fn(() => false),
      querySelector: vi.fn(),
    };
    const trigger = {
      isConnected: false,
      querySelector: vi.fn(),
    };

    openPhotoLightbox(/** @type {any} */ (host), /** @type {any} */ (trigger));

    expect(host.contains).not.toHaveBeenCalled();
    expect(trigger.querySelector).not.toHaveBeenCalled();
  });
});
