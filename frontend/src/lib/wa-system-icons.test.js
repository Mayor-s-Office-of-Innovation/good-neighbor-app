import { existsSync, globSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

  // System icons resolve to public/icons, and a missing file 404s to the app
  // shell, so the icon renders blank (#651: the <wa-select> caret).
  it("self-hosts every system icon the app's Web Awesome components draw", () => {
    const frontend = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const require = createRequire(import.meta.url);
    // Drawn only behind features the app does not use (password toggle).
    const unused = new Set(["eye", "eye-slash"]);
    // Names a component picks in code, keyed by its variable. Check the
    // component source when adding one.
    /** @type {Record<string, string[]>} */
    const computed = { iconName: ["check", "indeterminate"] };
    /** @type {string[]} */
    const unlisted = [];

    // Every Web Awesome component the app imports (not tests or src/dev).
    const components = new Set(
      globSync("src/**/*.js", { cwd: frontend })
        .filter((f) => !f.endsWith(".test.js") && !f.startsWith("src/dev/"))
        .flatMap((f) => [
          ...readFileSync(resolve(frontend, f), "utf8").matchAll(
            /@awesome\.me\/webawesome\/dist\/components\/[\w-]+\/[\w-]+\.js/g,
          ),
        ])
        .map((m) => m[0]),
    );
    const seen = new Set();
    const names = new Set();
    // Read a component's source in node_modules and follow its relative
    // imports, collecting the name of each <wa-icon library="system">.
    const visit = (/** @type {string} */ file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/<wa-icon\b[^>]*>/g)) {
        if (!/library="system"/.test(m[0])) continue;
        const name = /\bname=("?\$\{[^}]*\}"?|"[^"]*")/.exec(m[0])?.[1];
        if (!name) continue;
        // Literal names, including both arms of name="${rtl ? "a" : "b"}".
        const literals = [...name.matchAll(/"([\w-]+)"/g)].map((n) => n[1]);
        // A name chosen in code (name=${x}) can't be read here, so it fails
        // the test until its possible values are listed in `computed`.
        const variable = /^"?\$\{\s*(\w+)\s*\}"?$/.exec(name)?.[1];
        if (variable && !computed[variable]) unlisted.push(`${file}: ${name}`);
        for (const n of variable ? (computed[variable] ?? []) : literals)
          names.add(n);
      }
      for (const m of src.matchAll(
        /from\s+"(\.[^"]+)"|import\s+"(\.[^"]+)"/g,
      )) {
        visit(resolve(dirname(file), m[1] ?? m[2]));
      }
    };
    for (const spec of components) visit(require.resolve(spec));

    expect(names).toContain("chevron-down");
    expect(unlisted).toEqual([]);
    // Every collected name needs public/icons/<name>.svg.
    const missing = [...names].filter(
      (name) =>
        !unused.has(name) &&
        !existsSync(resolve(frontend, `public/icons/${name}.svg`)),
    );
    expect(missing).toEqual([]);
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
