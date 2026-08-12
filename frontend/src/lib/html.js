/*
  Tiny templating helpers shared by the *.templates.js modules.

  `html` is an IDENTITY tag: it concatenates a template literal exactly like an
  untagged one would — no runtime cost, no dependency. Its only job is to be named
  `html`, which is what editor extensions (e.g. Tobermory.es6-string-html) and
  Prettier key off to syntax-highlight and format the HTML inside the literal.

  Always interpolate untrusted / user-supplied strings through escapeHtml (in text)
  or escapeAttr (in an attribute value) to avoid HTML injection.
*/
export const html = (strings, ...values) =>
  strings.reduce(
    (out, s, i) => out + s + (i < values.length ? values[i] : ""),
    "",
  );

export function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

// Attribute values need the same escaping as text for our purposes (quotes matter
// most inside attributes; the rest are escaped too, which is harmless).
export const escapeAttr = escapeHtml;
