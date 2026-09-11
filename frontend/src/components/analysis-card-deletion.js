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
      try {
        await render();
      } catch (error) {
        console.error("refresh after analysis deletion failed", error);
      }
      if (host.isConnected) {
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
}

/** @param {HTMLElement} card */
export function collapseCard(card) {
  // CSS owns intrinsic sizing, spacing, timing, and reduced motion. The inner
  // clip keeps the card's contents stationary as its grid row closes.
  const shell = document.createElement("div");
  const clip = document.createElement("div");
  shell.className = "analysis-card--deleting";
  clip.className = "analysis-card__deletion-clip";
  card.before(shell);
  shell.append(clip);
  clip.append(card);
  card.inert = true;
  // Observe CSS animations only; cancellation (including navigation) also
  // completes cleanup. With animation disabled, the empty list settles at once.
  return Promise.allSettled(
    shell.getAnimations().map((animation) => animation.finished),
  ).then(() => shell.remove());
}
