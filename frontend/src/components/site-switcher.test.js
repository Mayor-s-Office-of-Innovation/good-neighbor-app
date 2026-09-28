import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Node environment (no DOM): covers the outside-click decision. The menu
  markup is tested in site-switcher.templates.test.js.
*/

let SiteSwitcher;
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("document", {
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal("customElements", {
    define: (name, component) => {
      if (name === "site-switcher") SiteSwitcher = component;
    },
  });
  await import("./site-switcher.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("site-switcher outside click", () => {
  it("stays open for clicks inside it or on its opener, closes otherwise", () => {
    const switcher = new SiteSwitcher();
    switcher.render = vi.fn();
    class OpenerButton {
      matches(selector) {
        return selector.includes("data-opens-site-switcher");
      }
    }
    vi.stubGlobal("Element", OpenerButton);
    switcher._open = true;

    switcher._handleDocumentClick({ composedPath: () => [switcher] });
    expect(switcher.open).toBe(true);

    switcher._handleDocumentClick({ composedPath: () => [new OpenerButton()] });
    expect(switcher.open).toBe(true);

    switcher._handleDocumentClick({ composedPath: () => [] });
    expect(switcher.open).toBe(false);
    expect(switcher.render).toHaveBeenCalledTimes(1);
  });

  it("clears a shown error when toggled", () => {
    const switcher = new SiteSwitcher();
    switcher.render = vi.fn();
    switcher.querySelector = () => null;
    switcher.showError("Nope");
    expect(switcher._error).toBe("Nope");
    switcher.setOpen(true);
    expect(switcher._error).toBe("");
    expect(switcher.open).toBe(true);
  });
});
