/** Keep unchanged cards (and their loaded images) while reconciling result markup. */
const authored = new WeakMap();
const key = (node) => {
  if (!(node instanceof Element) || !node.matches(".analysis-card")) return "";
  const condition = node.getAttribute("data-condition-id") || "";
  const evidence =
    node.getAttribute("data-item-id") ||
    node.getAttribute("data-artifact-id") ||
    "";
  const task = node.getAttribute("data-task-id") || "";
  return condition || evidence || task
    ? JSON.stringify([
        node.getAttribute("data-check-id") || "",
        evidence,
        condition,
        task,
      ])
    : "";
};

/** @param {Element} host @param {string} previous @param {string} markup */
export function reconcileHomeResults(host, previous, markup) {
  if (!previous || typeof document.createElement !== "function") return false;
  const oldTemplate = document.createElement("template");
  const nextTemplate = document.createElement("template");
  oldTemplate.innerHTML = previous;
  nextTemplate.innerHTML = markup;
  const oldRegion = oldTemplate.content.querySelector(".home-region--results");
  const nextRegion = nextTemplate.content.querySelector(
    ".home-region--results",
  );
  const live = host.querySelector(".home-region--results");
  if (!oldRegion || !nextRegion || !live) return false;
  // Anonymous summary/clear cards retain the full renderer's wiring path.
  if (
    [
      ...oldRegion.querySelectorAll(".analysis-card"),
      ...nextRegion.querySelectorAll(".analysis-card"),
    ].some((card) => !key(card))
  )
    return false;
  // Ambiguous identities must use the full renderer instead of dropping cards.
  for (const region of [oldRegion, nextRegion, live]) {
    const keys = [...region.querySelectorAll(".analysis-card")].map(key);
    if (new Set(keys).size !== keys.length) return false;
  }
  const controls = (region) =>
    [...region.querySelectorAll("button, select, wa-select")]
      .filter((node) => !node.closest(".analysis-card"))
      .map((node) =>
        [node.tagName, node.id, node.getAttribute("data-home-filter")].join(
          ":",
        ),
      )
      .join("|");
  if (controls(oldRegion) !== controls(nextRegion)) return false;
  const desired = nextRegion.cloneNode(true);
  oldRegion.replaceWith(document.createComment("results"));
  nextRegion.replaceWith(document.createComment("results"));
  if (oldTemplate.innerHTML !== nextTemplate.innerHTML) return false;
  const cards = new Map(
    [...live.querySelectorAll(".analysis-card")].map((card) => [
      key(card),
      card,
    ]),
  );
  // Compare authored markup, not DOM mutated by image loading or busy controls.
  const old = document.createElement("template");
  old.innerHTML = previous;
  for (const card of old.content.querySelectorAll(".analysis-card")) {
    const held = cards.get(key(card));
    if (held && !authored.has(held)) authored.set(held, card.outerHTML);
  }
  patch(live, desired, cards);
  return true;
}

/** @param {Node} live @param {Node} desired @param {Map<string, Element>} cards */
function patch(live, desired, cards) {
  if (live instanceof Element && desired instanceof Element) {
    for (const attr of [...live.attributes])
      if (!desired.hasAttribute(attr.name)) live.removeAttribute(attr.name);
    for (const attr of desired.attributes)
      if (live.getAttribute(attr.name) !== attr.value)
        live.setAttribute(attr.name, attr.value);
  }
  let cursor = live.firstChild;
  for (const next of [...desired.childNodes]) {
    const id = key(next);
    const held = id && cards.get(id);
    if (
      held &&
      next instanceof Element &&
      authored.get(held) === next.outerHTML
    ) {
      if (held !== cursor) {
        const move = /** @type {any} */ (live).moveBefore;
        if (typeof move === "function" && held.isConnected && live.isConnected)
          move.call(live, held, cursor);
        else live.insertBefore(held, cursor);
      }
      cursor = held.nextSibling;
      continue;
    }
    if (id && next instanceof Element) {
      // Changed card gets fresh controls, but retains an already-loaded photo.
      const photo = held?.querySelector("artifact-photo");
      const replacement = next.querySelector("artifact-photo");
      const html = next.outerHTML;
      if (
        photo &&
        replacement &&
        photo.getAttribute("data-check-id") ===
          replacement.getAttribute("data-check-id") &&
        photo.getAttribute("data-artifact-id") ===
          replacement.getAttribute("data-artifact-id") &&
        photo.querySelector("img")?.dataset.src ===
          replacement.querySelector("img")?.dataset.src
      )
        replacement.replaceWith(photo);
      live.insertBefore(next, cursor);
      authored.set(next, html);
      continue;
    }
    if (
      cursor &&
      !key(cursor) &&
      cursor.nodeType === next.nodeType &&
      cursor.nodeName === next.nodeName
    ) {
      if (
        cursor.nodeType === Node.TEXT_NODE ||
        cursor.nodeType === Node.COMMENT_NODE
      ) {
        if (cursor.nodeValue !== next.nodeValue)
          cursor.nodeValue = next.nodeValue;
      } else patch(cursor, next, cards);
      cursor = cursor.nextSibling;
    } else live.insertBefore(next, cursor);
  }
  while (cursor) {
    const remove = cursor;
    cursor = cursor.nextSibling;
    live.removeChild(remove);
  }
}
