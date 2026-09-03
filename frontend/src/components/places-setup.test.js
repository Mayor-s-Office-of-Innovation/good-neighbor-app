import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { placesShell } from "./places-setup.templates.js";

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("customElements", { define: vi.fn() });
  vi.stubGlobal("crypto", { randomUUID: () => "uuid-1" });
  vi.stubGlobal("location", { pathname: "/places/setup" });
  vi.stubGlobal("history", { pushState: vi.fn() });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
  vi.stubGlobal("document", { addEventListener: vi.fn() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("places setup template", () => {
  it("uses places copy for the save action", () => {
    const markup = renderPlaces({
      places: [{ id: "place-1", name: "Front entrance" }],
      canSave: true,
    });

    expect(markup).toContain("Save places");
    expect(markup).not.toContain("Save locations");
  });

  it("does not show numbering or a place menu for one named place", () => {
    const markup = renderPlaces({
      places: [{ id: "place-1", name: "Front entrance" }],
      canSave: true,
    });

    expect(markup).toContain("places-row--single");
    expect(markup).not.toContain("places-row__number");
    expect(markup).not.toContain("data-place-menu");
  });

  it("does not show a right-side menu on first-run with one blank field", () => {
    const markup = renderPlaces({
      places: [{ id: "place-1", name: "" }],
      canAdd: false,
      canSave: false,
    });

    expect(markup).not.toContain("data-place-menu");
    expect(markup).toContain('id="add-place"');
    expect(markup).toMatch(/id="add-place"[\s\S]*disabled/);
    expect(markup).toMatch(/id="save-places"[\s\S]*disabled/);
  });

  it("shows numbering and a menu once there are multiple rows", () => {
    const markup = renderPlaces({
      places: [
        { id: "place-1", name: "Front entrance" },
        { id: "place-2", name: "6th St" },
      ],
      canSave: true,
    });

    expect(markup).toContain("places-row__number");
    expect(markup).toContain('data-place-menu="0"');
    expect(markup).toContain('data-place-menu="1"');
  });
});

describe("places setup helpers", () => {
  it("trims place names and drops blank places before saving", async () => {
    const { cleanPlaces } = await import("./places-setup.js");

    expect(
      cleanPlaces([
        { id: "place-1", name: "  Front entrance  " },
        { id: "place-2", name: "   " },
      ]),
    ).toEqual([{ id: "place-1", name: "Front entrance" }]);
  });

  it("requires at least one confirmed named place before leaving first-run", async () => {
    const { hasConfirmedPlaces } = await import("./app-root.js");

    expect(
      hasConfirmedPlaces({
        placesConfirmedAt: "2026-09-03T00:00:00.000Z",
        places: [{ id: "place-1", name: "   " }],
      }),
    ).toBe(false);
    expect(
      hasConfirmedPlaces({
        placesConfirmedAt: "2026-09-03T00:00:00.000Z",
        places: [{ id: "place-1", name: " Front entrance " }],
      }),
    ).toBe(true);
  });
});

function renderPlaces(overrides = {}) {
  return placesShell({
    title: "Places you check",
    subtitle: "Subtitle",
    siteName: "Test site",
    places: [],
    canAdd: true,
    canSave: false,
    mode: "setup",
    menuIndex: null,
    ...overrides,
  });
}
