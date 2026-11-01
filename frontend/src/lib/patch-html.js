/** Update template-owned DOM while retaining keyed cards, focus and images. */
const markup = new WeakMap();
const key = (node) =>
  node instanceof Element
    ? node.id ||
      (node.hasAttribute("data-item-id")
        ? `item:${node.getAttribute("data-item-id")}:${node.getAttribute("data-condition-id") || ""}:${node.getAttribute("data-task-id") || ""}`
        : "")
    : "";

/** @param {Node} target @param {Node} source */
function patch(target, source) {
  if (target instanceof Element && source instanceof Element) {
    // Media elements own their image sources and placeholder state.
    if (["artifact-photo", "capture-photo"].includes(target.localName)) {
      for (const attr of [...source.attributes])
        if (target.getAttribute(attr.name) !== attr.value)
          target.setAttribute(attr.name, attr.value);
      const image = target.querySelector("img");
      const nextImage = source.querySelector("img");
      if (image && nextImage) image.alt = nextImage.alt;
      return;
    }
    for (const attr of [...target.attributes])
      if (!source.hasAttribute(attr.name)) target.removeAttribute(attr.name);
    for (const attr of [...source.attributes])
      if (target.getAttribute(attr.name) !== attr.value)
        target.setAttribute(attr.name, attr.value);
    patchChildren(target, source);
  } else if (target.nodeValue !== source.nodeValue)
    target.nodeValue = source.nodeValue;
}

/** @param {Node} target @param {Node} source */
function patchChildren(target, source) {
  const old = [...target.childNodes];
  const keyed = new Map(old.filter((n) => key(n)).map((n) => [key(n), n]));
  let cursor = target.firstChild;
  const kept = new Set();
  for (const desired of [...source.childNodes]) {
    const id = key(desired);
    let existing = id ? keyed.get(id) : cursor;
    if (
      !existing ||
      kept.has(existing) ||
      existing.nodeName !== desired.nodeName ||
      key(existing) !== id
    )
      existing = null;
    if (existing) {
      patch(existing, desired);
      if (existing !== cursor) target.insertBefore(existing, cursor);
    } else {
      existing = /** @type {ChildNode} */ (desired.cloneNode(true));
      target.insertBefore(existing, cursor);
    }
    kept.add(existing);
    cursor = existing.nextSibling;
  }
  for (const node of old) if (!kept.has(node)) node.remove();
}

/** @param {Element} target @param {string} html */
export function patchHtml(target, html) {
  if (markup.get(target) === html) return;
  const template = document.createElement("template");
  template.innerHTML = html;
  patchChildren(target, template.content);
  markup.set(target, html);
}
