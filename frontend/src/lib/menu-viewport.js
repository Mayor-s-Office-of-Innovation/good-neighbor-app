import "../styles/overlays.css";

// CSS owns size constraints and scrolling. This fallback measures trigger
// collisions and visual-viewport offsets (including zoom/keyboard changes),
// keeping the existing DOM, focus and dismissal behavior for Safari.
const menus = [
  [".home-action-menu", "#home-action-menu-trigger"],
  [".home-settings-menu", "#home-settings"],
  [".home-site-switcher__menu", "#site-switcher-trigger"],
];

/**
 * @param {HTMLElement} host
 * @param {(menu: HTMLElement) => void} [onDismiss] Keep owner state in sync.
 * @returns {() => void}
 */
export function containMenus(host, onDismiss = () => {}) {
  const update = () => {
    const viewport = window.visualViewport;
    const x = viewport?.offsetLeft || 0;
    const y = viewport?.offsetTop || 0;
    const width = viewport?.width || window.innerWidth;
    const height = viewport?.height || window.innerHeight;
    const gutter = 16;
    for (const [selector, triggerSelector] of menus) {
      const menu = host.querySelector(selector);
      const trigger = host.querySelector(triggerSelector);
      if (!(menu instanceof HTMLElement) || !trigger || menu.hidden) continue;
      // A nested site-switcher owns its own menu and dismissal state.
      const switcher = menu.closest("site-switcher");
      if (switcher && switcher !== host) continue;
      const rect = trigger.getBoundingClientRect();
      if (
        rect.bottom <= y ||
        rect.top >= y + height ||
        rect.right <= x ||
        rect.left >= x + width
      ) {
        if (
          menu.contains(document.activeElement) &&
          document.activeElement instanceof HTMLElement
        )
          document.activeElement.blur();
        menu.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
        onDismiss(menu);
        continue;
      }
      menu.setAttribute("data-viewport-menu", "");
      menu.style.setProperty("--menu-viewport-width", `${width}px`);
      menu.style.setProperty("--menu-viewport-height", `${height}px`);
      const below = Math.max(0, y + height - gutter - rect.bottom - 8);
      const above = Math.max(0, rect.top - y - gutter - 8);
      const flip = menu.scrollHeight > below && above > below;
      menu.style.setProperty(
        "--menu-available-height",
        `${flip ? above : below}px`,
      );
      const bounds = menu.getBoundingClientRect();
      const left = selector.includes("site-switcher")
        ? rect.left + (rect.width - bounds.width) / 2
        : rect.right - bounds.width;
      menu.style.left = `${Math.max(x + gutter, Math.min(left, x + width - gutter - bounds.width))}px`;
      menu.style.top = `${Math.max(y + gutter, Math.min(flip ? rect.top - 8 - bounds.height : rect.bottom + 8, y + height - gutter - bounds.height))}px`;
    }
  };
  const observer = new MutationObserver(update);
  observer.observe(host, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden"],
  });
  window.addEventListener("resize", update);
  document.addEventListener("scroll", update, true);
  window.visualViewport?.addEventListener("resize", update);
  window.visualViewport?.addEventListener("scroll", update);
  update();
  return () => {
    observer.disconnect();
    window.removeEventListener("resize", update);
    document.removeEventListener("scroll", update, true);
    window.visualViewport?.removeEventListener("resize", update);
    window.visualViewport?.removeEventListener("scroll", update);
  };
}
