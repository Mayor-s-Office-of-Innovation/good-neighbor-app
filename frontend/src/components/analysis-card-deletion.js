/** Hosts whose card DOM must survive session notifications during deletion. */
const deletingHosts = new Set();

/** @param {HTMLElement} host */
export function isDeletingAnalysisCard(host) {
  // A parent render also destroys cards owned by an embedded capture view.
  return [...deletingHosts].some(
    (owner) => owner === host || host.contains(owner),
  );
}

/**
 * Keep the existing card until the accepted deletion has visibly collapsed.
 * @param {HTMLElement} host
 * @param {{conditionId: string, artifactId: string}} problem
 * @param {() => Promise<unknown> | void} commit
 * @param {() => Promise<unknown> | void} render
 */
export async function deleteAnalysisCard(host, problem, commit, render) {
  const cards = [...host.querySelectorAll(".analysis-card")];
  const index = cards.findIndex(
    (card) =>
      card.getAttribute("data-condition-id") === problem.conditionId &&
      card.getAttribute("data-artifact-id") === problem.artifactId,
  );
  const card = /** @type {HTMLElement | undefined} */ (cards[index]);
  deletingHosts.add(host);
  let accepted = false;
  try {
    await commit();
    accepted = true;
    const dialog = /** @type {HTMLDialogElement | null} */ (
      host.querySelector("#analysis-delete-dialog")
    );
    dialog?.close();
    if (card?.isConnected) await collapseCard(card);
  } finally {
    deletingHosts.delete(host);
    if (host.isConnected && accepted) {
      await render();
      host.dispatchEvent(
        new CustomEvent("analysiscarddeleted", { bubbles: true }),
      );
      const remaining = host.querySelectorAll(".analysis-card");
      const next =
        remaining[Math.min(Math.max(index, 0), remaining.length - 1)];
      const target = /** @type {HTMLElement | null} */ (
        next?.querySelector("button") || host.querySelector("h2, h1")
      );
      if (target) {
        if (!target.matches("button")) target.setAttribute("tabindex", "-1");
        target.focus({ preventScroll: true });
      }
    }
  }
}

/** @param {HTMLElement} card */
export function collapseCard(card) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return Promise.resolve();
  }
  const height = card.getBoundingClientRect().height;
  const parent = card.parentElement;
  const gap =
    parent && parent.children.length > 1
      ? parseFloat(getComputedStyle(parent).rowGap) || 0
      : 0;
  // Clip a fixed-height card so flex alignment, text, and photos never shift
  // inside it as the outer footprint shrinks.
  const shell = document.createElement("div");
  card.before(shell);
  shell.append(card);
  card.style.height = `${height}px`;
  shell.style.setProperty("--deletion-height", `${height}px`);
  shell.style.setProperty("--deletion-gap", `${gap}px`);
  card.inert = true;
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      observer.disconnect();
      shell.removeEventListener("animationend", onEnd);
      shell.removeEventListener("animationcancel", onEnd);
      resolve();
    };
    const onEnd = (event) => {
      if (
        event.target === shell &&
        event.animationName === "analysis-card-collapse"
      )
        finish();
    };
    // Navigation or a removed ancestor must not leave deletion waiting on an event.
    const observer = new MutationObserver(() => {
      if (!card.isConnected) finish();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timeout = setTimeout(finish, 350);
    shell.addEventListener("animationend", onEnd);
    shell.addEventListener("animationcancel", onEnd);
    shell.classList.add("analysis-card--deleting");
  });
}
