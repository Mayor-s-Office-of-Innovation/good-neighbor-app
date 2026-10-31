/*
  Keyboard-aware viewport for the app shell.

  Android Chrome honours the viewport meta's interactive-widget=resizes-content
  and shrinks the layout viewport (and so 100svh) when the on-screen keyboard
  opens. WebKit does not implement it: on iPhone the keyboard overlays the page,
  only the visual viewport shrinks, and Safari pans it to reveal the focused
  field. Anything composed to the full layout viewport ends up beneath the
  keyboard.

  <app-root> mirrors the visual viewport into two custom properties while an
  editable control has focus, so the shell's flex chain composes into the
  visible area instead (see styles/base.css, "App shell"). Engines that resize the
  layout viewport report equal heights and the sync is a no-op there.
*/

/**
 * Follow focus through shadow roots (Web Awesome inputs keep their native
 * <input> inside one).
 * @param {Document} doc
 * @returns {Element | null}
 */
export function deepActiveElement(doc) {
  let el = doc.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

const EDITABLE =
  "input, textarea, [contenteditable=''], [contenteditable=true]";

/**
 * @param {Element | null} el
 * @returns {boolean}
 */
export function isEditable(el) {
  return Boolean(
    el && typeof el.matches === "function" && el.matches(EDITABLE),
  );
}

/**
 * Decide whether the keyboard occupies part of the layout viewport and, if so,
 * where the visible area sits.
 * @param {{ height: number, offsetTop: number, scale: number } | null | undefined} viewport
 *   window.visualViewport (or a stand-in)
 * @param {number} layoutHeight window.innerHeight
 * @param {boolean} editing whether an editable control has focus
 * @returns {{ height: number, top: number } | null} null when nothing to apply
 */
export function keyboardViewport(viewport, layoutHeight, editing) {
  if (!viewport || !editing) return null;
  // Pinch-zoom also shrinks the visual viewport; only react to the keyboard.
  if (viewport.scale > 1.01) return null;
  const height = Math.round(viewport.height);
  if (!(height > 0) || height >= layoutHeight - 1) return null;
  return { height, top: Math.max(0, Math.round(viewport.offsetTop)) };
}

/** Reveal a field inside the visual viewport, including nested modal scrollers.
 * scrollIntoView alone targets the layout viewport, which can extend below iOS's keyboard.
 * @param {Element | null} active
 * @param {{height: number, offsetTop: number, scale: number} | null | undefined} viewport
 */
export function revealEditable(active, viewport) {
  if (!active || !viewport || viewport.scale !== 1) return;
  const top = viewport.offsetTop + 16;
  const bottom = viewport.offsetTop + viewport.height - 16;
  const displacement = () => {
    const rect = active.getBoundingClientRect();
    if (rect.top < top) return rect.top - top;
    if (rect.height > bottom - top) return Math.max(0, rect.top - top);
    return Math.max(0, rect.bottom - bottom);
  };
  if (!displacement()) return;
  // First expose the field inside any clipping ancestors, then correct against
  // the actual visible area, rather than centering in the full layout viewport.
  active.scrollIntoView({ block: "nearest", behavior: "instant" });
  /** @type {Element | null} */
  let parent = active.parentElement;
  let node = active;
  while (node) {
    if (!parent) {
      const root = node.getRootNode();
      parent = root instanceof ShadowRoot ? root.host : null;
    }
    if (!parent) break;
    if (
      parent.scrollHeight > parent.clientHeight &&
      /auto|scroll|hidden/.test(getComputedStyle(parent).overflowY)
    ) {
      // Preserve visibility inside this scroller. Any remaining movement must
      // come from an outer scroller, rather than clipping the editor here.
      const field = active.getBoundingClientRect();
      const bounds = parent.getBoundingClientRect();
      const innerTop = bounds.top + parent.clientTop;
      const innerBottom = innerTop + parent.clientHeight;
      const delta = displacement();
      parent.scrollTop +=
        delta > 0
          ? Math.min(delta, Math.max(0, field.top - innerTop))
          : Math.max(delta, Math.min(0, field.bottom - innerBottom));
    }
    node = parent;
    parent = parent.parentElement;
  }
  window.scrollBy({ top: displacement(), behavior: "instant" });
}
