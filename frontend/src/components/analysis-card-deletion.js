import { stageDeletion } from "../state/pending-deletions.js";
import { showToast } from "../state/toasts.js";
import { t } from "../i18n/i18n.js";

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
 * Hide the card while an app-lifetime toast offers a cancellable deletion.
 * @param {HTMLElement} host
 * @param {import("../state/pending-deletions.js").DeletedProblem} problem
 * @param {() => Promise<unknown> | void} commit
 * @param {() => Promise<unknown> | void} render
 * @param {{focusUndo?: boolean, address?: string}} [options]
 */
export async function deleteAnalysisCard(
  host,
  problem,
  commit,
  render,
  { focusUndo = false, address = "" } = {},
) {
  const cards = [...host.querySelectorAll(".analysis-card")];
  const index = cards.findIndex(
    (card) =>
      card.getAttribute("data-condition-id") === problem.conditionId &&
      card.getAttribute("data-artifact-id") === problem.artifactId,
  );
  const card = /** @type {HTMLElement | undefined} */ (cards[index]);
  deletingHosts.add(host);
  let pending;
  let reference = problem.reference;
  try {
    reference =
      problem.reference ||
      card
        ?.querySelector(".analysis-card__meta")
        ?.textContent?.trim()
        .replace(metaLabelPrefix(), "");
    pending = stageDeletion({ ...problem, reference }, commit);
    if (!pending) return;
    const dialog = /** @type {HTMLDialogElement | null} */ (
      host.querySelector("#analysis-delete-dialog")
    );
    dialog?.close();
    if (card?.isConnected) await collapseCard(card);
  } finally {
    deletingHosts.delete(host);
    if (host.isConnected && pending) {
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
    if (pending) {
      showToast({
        title: t("card.deleteToast.title"),
        message: deletionSummary(problem.title, address),
        icon: "circle-check",
        tone: "success",
        focusAction: focusUndo,
        action: {
          label: t("common.undo"),
          run: () => pending.undo(),
        },
        onDismiss: () => {
          void pending.save();
        },
      });
    }
  }
}

/**
 * Strips the card's "NEW" / "NEEDS ACTION" meta prefix (and its separator) so
 * only the reference remains, in whatever language the card was rendered.
 * @returns {RegExp}
 */
function metaLabelPrefix() {
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const labels = [t("card.meta.new"), t("card.meta.needsAction")].map(escape);
  return new RegExp(`^(${labels.join("|")})\\s*•?\\s*`);
}

/** @param {string | undefined} label @param {string} address */
function deletionSummary(label, address) {
  const friendlyLabel = label || t("card.deleteToast.issueFallback");
  const firstAddressLine = address.split(/[\n,]/, 1)[0].trim();
  return firstAddressLine
    ? t("card.deleteToast.messageAt", {
        label: friendlyLabel,
        address: firstAddressLine,
      })
    : friendlyLabel;
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
