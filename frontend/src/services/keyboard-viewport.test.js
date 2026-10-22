import { describe, expect, it, vi } from "vitest";
import {
  deepActiveElement,
  isEditable,
  keyboardViewport,
  revealEditable,
} from "./keyboard-viewport.js";

/*
  Tests for services/keyboard-viewport.js — the shell's iOS keyboard fallback.
  Node environment: pure decisions over visualViewport-shaped values.
*/

describe("keyboardViewport", () => {
  const vv = (height, offsetTop = 0, scale = 1) => ({
    height,
    offsetTop,
    scale,
  });

  it("is a no-op without a visual viewport or without an editing focus", () => {
    expect(keyboardViewport(null, 844, true)).toBeNull();
    expect(keyboardViewport(undefined, 844, true)).toBeNull();
    expect(keyboardViewport(vv(500), 844, false)).toBeNull();
  });

  it("is a no-op when the layout viewport already resized with the keyboard", () => {
    expect(keyboardViewport(vv(500), 500, true)).toBeNull();
    expect(keyboardViewport(vv(499.6), 500, true)).toBeNull();
  });

  it("mirrors the visual viewport when the keyboard overlays the page", () => {
    expect(keyboardViewport(vv(500.4, 120.3), 844, true)).toEqual({
      height: 500,
      top: 120,
    });
    expect(keyboardViewport(vv(500, -3), 844, true)).toEqual({
      height: 500,
      top: 0,
    });
  });

  it("ignores pinch-zoom, which also shrinks the visual viewport", () => {
    expect(keyboardViewport(vv(300, 0, 2.5), 844, true)).toBeNull();
  });
});

describe("isEditable", () => {
  /** @param {(s: string) => boolean} selectorMatch */
  const el = (selectorMatch) =>
    /** @type {any} */ ({ matches: (s) => selectorMatch(s) });
  it("recognises native text controls only", () => {
    expect(isEditable(null)).toBe(false);
    expect(isEditable(/** @type {any} */ ({}))).toBe(false);
    expect(isEditable(el(() => true))).toBe(true);
    expect(isEditable(el(() => false))).toBe(false);
  });
});

describe("deepActiveElement", () => {
  it("follows focus into nested shadow roots", () => {
    const inner = { shadowRoot: null };
    const host = { shadowRoot: { activeElement: inner } };
    const outer = { shadowRoot: { activeElement: host } };
    const doc = (activeElement) => /** @type {any} */ ({ activeElement });
    expect(deepActiveElement(doc(outer))).toBe(inner);
    expect(deepActiveElement(doc(null))).toBeNull();
  });
});

describe("focused field clearance after Safari keyboard resize", () => {
  const viewport = { height: 400, offsetTop: 60, scale: 1 };
  function field(top, bottom) {
    return {
      getBoundingClientRect: () => ({ top, bottom, height: bottom - top }),
      scrollIntoView: vi.fn(),
    };
  }
  it("reveals an obscured field when the visual viewport shrinks", () => {
    const active = field(500, 600);
    revealEditable(active, viewport);
    expect(active.scrollIntoView).toHaveBeenCalledWith({
      block: "center",
      behavior: "instant",
    });
  });
  it("leaves visible controls and pinch zoom alone", () => {
    const active = field(100, 200);
    revealEditable(active, viewport);
    revealEditable(active, { ...viewport, scale: 2 });
    expect(active.scrollIntoView).not.toHaveBeenCalled();
  });
  it("aligns a tall field at its beginning without repeated centering", () => {
    const active = field(500, 1100);
    revealEditable(active, viewport);
    expect(active.scrollIntoView).toHaveBeenCalledWith({
      block: "start",
      behavior: "instant",
    });
    const visibleTop = field(76, 676);
    revealEditable(visibleTop, viewport);
    expect(visibleTop.scrollIntoView).not.toHaveBeenCalled();
  });
});
