import { afterEach, expect, it, vi } from "vitest";
import { containMenus } from "./menu-viewport.js";

afterEach(() => vi.unstubAllGlobals());

it("positions explicitly and listens only while an owned menu is open", () => {
  class Menu {
    hidden = true;
    style = { setProperty: vi.fn() };
    scrollHeight = 100;
    closest() {
      return null;
    }
    getAttributeNames() {
      return [];
    }
    setAttribute() {}
    contains() {
      return false;
    }
    getBoundingClientRect() {
      return { width: 100, height: 100 };
    }
  }
  vi.stubGlobal("HTMLElement", Menu);
  const viewport = new EventTarget();
  Object.assign(viewport, { width: 400, height: 600 });
  const win = new EventTarget();
  Object.assign(win, { visualViewport: viewport });
  const doc = new EventTarget();
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  const targets = [win, doc, viewport];
  const adds = targets.map((target) => vi.spyOn(target, "addEventListener"));
  const removes = targets.map((target) =>
    vi.spyOn(target, "removeEventListener"),
  );
  const menu = new Menu();
  let top = 50;
  const trigger = {
    getBoundingClientRect: () => ({
      top,
      bottom: top + 20,
      left: 100,
      right: 120,
    }),
    setAttribute: vi.fn(),
  };
  const host = {
    querySelector: (selector) =>
      ({
        ".home-action-menu": menu,
        "#home-action-menu-trigger": trigger,
      })[selector],
  };
  const dismiss = vi.fn();
  const stop = containMenus(
    /** @type {HTMLElement} */ (/** @type {unknown} */ (host)),
    dismiss,
  );
  stop.update();
  expect(adds.every((spy) => spy.mock.calls.length === 0)).toBe(true);

  menu.hidden = false;
  stop.update();
  expect(menu.style.top).toBe("78px");
  expect(adds.map((spy) => spy.mock.calls.length)).toEqual([1, 1, 2]);
  stop.update();
  expect(adds.map((spy) => spy.mock.calls.length)).toEqual([1, 1, 2]);
  top = 100;
  doc.dispatchEvent(new Event("scroll"));
  expect(menu.style.top).toBe("128px");

  menu.hidden = true;
  stop.update();
  expect(removes.map((spy) => spy.mock.calls.length)).toEqual([1, 1, 2]);
  menu.hidden = false;
  stop.update();
  top = -100;
  viewport.dispatchEvent(new Event("scroll"));
  expect(menu.hidden).toBe(true);
  expect(dismiss.mock.calls[0]?.[0] === menu).toBe(true);
  expect(removes.map((spy) => spy.mock.calls.length)).toEqual([2, 2, 4]);

  top = 50;
  menu.hidden = false;
  stop.update();
  stop();
  expect(removes.map((spy) => spy.mock.calls.length)).toEqual([3, 3, 6]);
});
