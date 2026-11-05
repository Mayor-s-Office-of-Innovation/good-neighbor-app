import { expect, it } from "vitest";
import { bindYesNoChoice, yesNoChoice } from "./yes-no-choice.js";

/**
 * @param {string} markup
 * @param {"yes" | "no"} answer
 */
const buttonFor = (markup, answer) =>
  markup.match(new RegExp(`<button[^>]*data-pick="${answer}"[^>]*>`))?.[0] ??
  "";

it.each([
  { value: null, yes: "btn-outline", no: "btn-outline" },
  { value: true, yes: "btn-ink", no: "btn-outline" },
  { value: false, yes: "btn-outline", no: "btn-ink" },
])("fills only the picked answer: $value", ({ value, yes, no }) => {
  const markup = yesNoChoice({
    name: "pick",
    value,
    yesLabel: "Y",
    noLabel: "N",
  });
  expect(buttonFor(markup, "yes")).toContain(`class="${yes}"`);
  expect(buttonFor(markup, "no")).toContain(`class="${no}"`);
  expect(buttonFor(markup, "yes")).toContain(
    `aria-pressed="${value === true}"`,
  );
  expect(buttonFor(markup, "no")).toContain(
    `aria-pressed="${value === false}"`,
  );
});

it("escapes labels, adds layout classes, and disables both buttons", () => {
  const markup = yesNoChoice({
    name: "pick",
    value: null,
    yesLabel: "<b>",
    noLabel: "N",
    disabled: true,
    className: "extra",
  });
  expect(markup).toContain('class="yes-no-choice extra"');
  expect(markup).toContain("&lt;b&gt;");
  expect(buttonFor(markup, "yes")).toContain("disabled");
  expect(buttonFor(markup, "no")).toContain("disabled");
});

/** @param {"yes" | "no"} answer */
function fakeButton(answer) {
  /** @type {Record<string, string>} */
  const attrs = { "data-pick": answer };
  /** @type {() => void} */
  let click = () => {};
  return {
    className: "btn-outline",
    getAttribute: (/** @type {string} */ key) => attrs[key] ?? null,
    setAttribute: (/** @type {string} */ key, /** @type {string} */ v) => {
      attrs[key] = v;
    },
    addEventListener: (
      /** @type {string} */ _type,
      /** @type {() => void} */ fn,
    ) => {
      click = fn;
    },
    click: () => click(),
    attrs,
  };
}

it("restyles in place and reports the answer", () => {
  const yes = fakeButton("yes");
  const no = fakeButton("no");
  const root = /** @type {ParentNode} */ (
    /** @type {unknown} */ ({ querySelectorAll: () => [yes, no] })
  );
  /** @type {boolean[]} */
  const seen = [];
  bindYesNoChoice(root, "pick", (value) => {
    seen.push(value);
  });

  no.click();
  expect(seen).toEqual([false]);
  expect(no.className).toBe("btn-ink");
  expect(yes.className).toBe("btn-outline");
  expect(no.attrs["aria-pressed"]).toBe("true");
  expect(yes.attrs["aria-pressed"]).toBe("false");

  yes.click();
  expect(seen).toEqual([false, true]);
  expect(yes.className).toBe("btn-ink");
  expect(no.className).toBe("btn-outline");
});

it("leaves the buttons alone when the caller rejects the click", () => {
  const yes = fakeButton("yes");
  const no = fakeButton("no");
  const root = /** @type {ParentNode} */ (
    /** @type {unknown} */ ({ querySelectorAll: () => [yes, no] })
  );
  bindYesNoChoice(root, "pick", () => false);
  yes.click();
  expect(yes.className).toBe("btn-outline");
  expect(yes.attrs["aria-pressed"]).toBeUndefined();
});
