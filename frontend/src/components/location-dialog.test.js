import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Node environment (no DOM): covers open() focus order and the event
  contract. The markup is tested in location-dialog.templates.test.js.
*/

let LocationDialog;
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal(
    "CustomEvent",
    class {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
  );
  vi.stubGlobal("customElements", {
    define: (name, component) => {
      if (name === "location-dialog") LocationDialog = component;
    },
  });
  await import("./location-dialog.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubbedDialog() {
  const element = new LocationDialog();
  element.currentSite = { siteId: "site-1", name: "Mission" };
  element.sites = [
    { siteId: "site-1", name: "Mission" },
    { siteId: "site-2", name: "Second" },
  ];
  element.render = vi.fn();
  element.dispatchEvent = vi.fn();
  const focus = vi.fn();
  const showModal = vi.fn();
  const dialog = {
    showModal,
    close: vi.fn(),
    querySelector: vi.fn((selector) =>
      selector === '.location-dialog__site[aria-pressed="true"]'
        ? { focus }
        : null,
    ),
  };
  element.querySelector = (selector) =>
    selector === "#location-dialog" ? dialog : null;
  return { element, dialog, focus, showModal };
}

describe("location-dialog open()", () => {
  it("resets the highlight to the bound site, shows the modal, then focuses it", () => {
    const { element, dialog, focus, showModal } = stubbedDialog();
    element._selectedSiteId = "site-2";
    element.open({ flowType: "perimeter" });

    expect(element.selectedSiteId).toBe("site-1");
    expect(element.render).toHaveBeenCalledOnce();
    expect(showModal).toHaveBeenCalledOnce();
    expect(dialog.querySelector).toHaveBeenCalledWith(
      '.location-dialog__site[aria-pressed="true"]',
    );
    expect(focus).toHaveBeenCalledOnce();
    expect(showModal.mock.invocationCallOrder[0]).toBeLessThan(
      focus.mock.invocationCallOrder[0],
    );
    expect(element._prompt).toEqual({ flowType: "perimeter" });
  });
});
