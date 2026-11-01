/** Pull only from the card region at the top of the page; never from an editor.
 * @param {HTMLElement} host
 * @param {() => Promise<unknown>} refresh
 * @returns {() => void}
 */
export function installHomeRefresh(host, refresh) {
  let start = null;
  let distance = 0;
  let pending = false;
  let lastFailed = false;
  let disposed = false;
  let wheelTimer;
  const paintPull = (pixels, pulling = true) => {
    const offset = Math.min(104, pixels * 0.65);
    host.style.setProperty("--home-pull-offset", `${offset}px`);
    host.style.setProperty(
      "--home-pull-angle",
      `${Math.min(1, pixels / 72) * 270}deg`,
    );
    host.toggleAttribute("data-home-pull-active", pixels > 0);
    host.toggleAttribute("data-home-pulling", pulling && pixels > 0);
  };
  const settle = () => {
    paintPull(lastFailed ? 140 : 0, false);
  };
  const run = async () => {
    if (pending || disposed) return;
    clearTimeout(wheelTimer);
    pending = true;
    lastFailed = false;
    paintPull(86, false);
    host.setAttribute("data-home-refreshing", "");
    let failed = false;
    try {
      await refresh();
    } catch {
      failed = true;
    } finally {
      pending = false;
      lastFailed = failed;
      host.removeAttribute("data-home-refreshing");
      if (!disposed) paintPull(failed ? 140 : 0, false);
    }
  };
  const eligible = (target, y) => {
    if (
      pending ||
      disposed ||
      window.scrollY > 0 ||
      document.querySelector("dialog[open]")
    )
      return false;
    if (
      !(target instanceof Element) ||
      !target.closest(".home-region--results") ||
      target.closest(
        "button, a, input, textarea, select, [contenteditable], wa-textarea, wa-input",
      )
    )
      return false;
    const tabs = host.querySelector(".home-tabs");
    if (!tabs || y < tabs.getBoundingClientRect().bottom) return false;
    // Nested scrollers own their gestures, even at their own scroll boundary.
    for (let node = target; node && node !== host; node = node.parentElement) {
      if (
        node.scrollHeight > node.clientHeight &&
        /auto|scroll/.test(getComputedStyle(node).overflowY)
      )
        return false;
    }
    return true;
  };
  let mouseDown = false;
  const mouseBegin = (event) => {
    if (
      event.button !== 0 ||
      !eligible(event.target, event.clientY) ||
      window.getSelection()?.toString()
    )
      return;
    // Start on card padding/background, not selectable text.
    for (const child of event.target.childNodes) {
      if (child.nodeType !== Node.TEXT_NODE || !child.textContent?.trim())
        continue;
      const range = document.createRange();
      range.selectNodeContents(child);
      if (
        [...range.getClientRects()].some(
          (rect) =>
            event.clientX >= rect.left &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom,
        )
      )
        return;
    }
    mouseDown = true;
    start = { x: event.clientX, y: event.clientY };
    distance = 0;
    event.preventDefault();
  };
  const mouseMove = (event) => {
    if (!mouseDown) return;
    if (event.buttons !== 1) {
      mouseDown = false;
      cancel();
      return;
    }
    move({
      touches: [event],
      cancelable: event.cancelable,
      preventDefault: () => event.preventDefault(),
    });
  };
  const mouseEnd = () => {
    if (mouseDown) {
      mouseDown = false;
      end();
    }
  };
  const blur = () => {
    mouseDown = false;
    cancel();
  };
  let wheelDistance = 0;
  let wheelAt = 0;
  let wheelTriggered = false;
  const wheel = (event) => {
    const now = performance.now();
    if (now - wheelAt > 350) {
      wheelDistance = 0;
      wheelTriggered = false;
    }
    wheelAt = now;
    if (
      event.ctrlKey ||
      event.metaKey ||
      event.deltaY >= 0 ||
      Math.abs(event.deltaX) > Math.abs(event.deltaY) ||
      !eligible(event.target, event.clientY)
    ) {
      wheelDistance = 0;
      clearTimeout(wheelTimer);
      if (!pending) settle();
      return;
    }
    if (wheelTriggered) return;
    const unit =
      event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? window.innerHeight
          : 1;
    wheelDistance += -event.deltaY * unit;
    paintPull(wheelDistance * 0.6);

    clearTimeout(wheelTimer);
    // Wheel events have no release event. A quiet interval marks the end of
    // the trackpad/wheel gesture; inertia cannot enqueue a second refresh.
    wheelTimer = setTimeout(() => {
      if (disposed || pending) return;
      if (wheelDistance >= 120) {
        wheelTriggered = true;
        void run();
      } else settle();
      wheelDistance = 0;
    }, 160);
  };
  const begin = (event) => {
    start = null;
    distance = 0;
    if (
      pending ||
      event.touches.length !== 1 ||
      window.scrollY > 0 ||
      document.querySelector("dialog[open]")
    )
      return;
    const target = event.target;
    if (
      !(target instanceof Element) ||
      !target.closest(".home-region--results") ||
      target.closest(
        "button, a, input, textarea, select, [contenteditable], wa-textarea, wa-input",
      )
    )
      return;
    const tabs = host.querySelector(".home-tabs");
    const touch = event.touches[0];
    if (!tabs || touch.clientY < tabs.getBoundingClientRect().bottom) return;
    start = { x: touch.clientX, y: touch.clientY };
  };
  const move = (event) => {
    if (!start) return;
    if (event.touches.length !== 1 || window.scrollY > 0) {
      cancel();
      return;
    }
    const touch = event.touches[0];
    const dy = touch.clientY - start.y;
    if (
      Math.abs(touch.clientX - start.x) > Math.max(12, Math.abs(dy)) ||
      dy < -8
    ) {
      cancel();
      return;
    }
    distance = Math.max(0, dy);
    if (distance > 12 && event.cancelable) event.preventDefault();
    paintPull(distance);
  };
  const end = () => {
    const ready = start && distance >= 72;
    start = null;
    distance = 0;
    if (ready) void run();
    else if (!pending) settle();
  };
  const cancel = () => {
    start = null;
    distance = 0;
    clearTimeout(wheelTimer);
    if (!pending) settle();
  };
  host.addEventListener("mousedown", mouseBegin);
  window.addEventListener("mousemove", mouseMove);
  window.addEventListener("mouseup", mouseEnd);
  window.addEventListener("blur", blur);
  host.addEventListener("wheel", wheel, { passive: true });
  host.addEventListener("touchstart", begin, { passive: true });
  host.addEventListener("touchmove", move, { passive: false });
  host.addEventListener("touchend", end);
  host.addEventListener("touchcancel", cancel);
  return () => {
    disposed = true;
    clearTimeout(wheelTimer);
    paintPull(0, false);
    host.removeEventListener("mousedown", mouseBegin);
    window.removeEventListener("mousemove", mouseMove);
    window.removeEventListener("mouseup", mouseEnd);
    window.removeEventListener("blur", blur);
    host.removeEventListener("wheel", wheel);
    host.removeEventListener("touchstart", begin);
    host.removeEventListener("touchmove", move);
    host.removeEventListener("touchend", end);
    host.removeEventListener("touchcancel", cancel);
  };
}
