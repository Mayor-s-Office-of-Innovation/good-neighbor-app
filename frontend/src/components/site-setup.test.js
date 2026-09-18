import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let readCodeFromUrl;
let stripCodeFromUrl;
beforeAll(async () => {
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("customElements", { get: () => true });
  ({ readCodeFromUrl, stripCodeFromUrl } = await import("./site-setup.js"));
});
afterEach(() => vi.unstubAllGlobals());

describe("setup code URLs", () => {
  it.each([
    ["/#code=ABC123", "ABC123"],
    ["/?code=OLD123", "OLD123"],
    ["/?code=OLD123#code=ABC123", "ABC123"],
    ["/#code=%20ABC123%20", "ABC123"],
    ["/", ""],
  ])("reads %s", (path, expected) => {
    vi.stubGlobal("location", new URL(path, "https://goodneighborsf.org"));
    expect(readCodeFromUrl()).toBe(expected);
  });

  it.each([
    ["/?theme=dark#code=ABC123&section=setup", "/?theme=dark#section=setup"],
    ["/?code=OLD123&theme=dark#code=ABC123", "/?theme=dark"],
    ["/?code=OLD123#heading", "/#heading"],
    ["/#code=ABC123", "/"],
  ])(
    "removes codes from %s while preserving other URL values",
    (path, expected) => {
      vi.stubGlobal("location", new URL(path, "https://goodneighborsf.org"));
      const replaceState = vi.fn();
      vi.stubGlobal("history", { replaceState });
      stripCodeFromUrl();
      expect(replaceState).toHaveBeenCalledWith(null, "", expected);
    },
  );

  it("does not rewrite a URL without a code", () => {
    vi.stubGlobal(
      "location",
      new URL("https://goodneighborsf.org/?theme=dark#heading"),
    );
    const replaceState = vi.fn();
    vi.stubGlobal("history", { replaceState });
    stripCodeFromUrl();
    expect(replaceState).not.toHaveBeenCalled();
  });
});
