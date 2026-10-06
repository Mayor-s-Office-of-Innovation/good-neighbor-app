import { describe, expect, it } from "vitest";
import {
  icons,
  library_system_default,
  mutateSystemIcon,
  resolveSystemIcon,
} from "./wa-system-icons.js";

describe("wa-system-icons (aliased Web Awesome system library)", () => {
  it("resolves system icon names to the self-hosted icon set", () => {
    expect(resolveSystemIcon("chevron-down")).toBe("/icons/chevron-down.svg");
    expect(resolveSystemIcon("")).toBe("");
  });

  it("exposes the vendor chunk's export shape with no inlined markup", () => {
    expect(library_system_default.name).toBe("system");
    expect(library_system_default.resolver).toBe(resolveSystemIcon);
    expect(library_system_default.mutator).toBe(mutateSystemIcon);
    expect(icons).toEqual({ solid: {}, regular: {} });
  });

  it("makes icons inherit the text color", () => {
    /** @type {string[][]} */
    const calls = [];
    const fakeSvg = {
      setAttribute: (/** @type {string} */ k, /** @type {string} */ v) =>
        calls.push([k, v]),
    };
    mutateSystemIcon(
      /** @type {SVGElement} */ (/** @type {unknown} */ (fakeSvg)),
    );
    expect(calls).toEqual([["fill", "currentColor"]]);
  });
});
