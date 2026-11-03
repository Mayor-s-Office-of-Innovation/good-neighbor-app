import { getTaskDeletionScope } from "../services/api.js";
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

/** Resolve the server-owned deletion scope before enabling confirmation.
 * @param {HTMLElement} host @param {any} problem
 */
export async function prepareCardDeletion(host, problem) {
  const button = /** @type {HTMLButtonElement | null} */ (
    host.querySelector("#analysis-delete-confirm")
  );
  const copy = host.querySelector("#analysis-delete-copy");
  copy?.setAttribute("aria-live", "polite");
  host.querySelector("[data-delete-selected]")?.remove();
  delete problem.deletionMode;
  delete problem.deletionTargets;
  if (button) {
    button.hidden = false;
    button.disabled = true;
    button.textContent = t("common.delete");
  }
  if (copy) copy.textContent = t("analysis.deleteDialog.loading");
  let selected;
  const chooseSelected = () => {
    problem.deletionMode = "selected";
    problem.deletionTargets = selected.targets;
    if (copy) copy.textContent = t("analysis.deleteDialog.selectedText");
    if (button) {
      button.disabled = false;
      button.textContent = t("analysis.deleteDialog.selectedDelete");
    }
    host.querySelector("[data-delete-selected]")?.remove();
    button?.focus();
  };
  try {
    if (problem.taskId) {
      selected = (await getTaskDeletionScope(problem.taskId, true)).deletion;
      if (host["_activeProblem"] !== problem) return;
      if (
        selected?.targets?.length !== 1 ||
        selected.targets[0].taskId !== problem.taskId
      )
        throw new Error(
          "Selected-card scope does not identify exactly the clicked card",
        );
      const fallback = document.createElement("button");
      fallback.type = "button";
      fallback.className =
        "btn-outline analysis-dialog__button analysis-dialog__button--outline";
      fallback.dataset.deleteSelected = "";
      fallback.textContent = t("analysis.deleteDialog.selectedDelete");
      fallback.addEventListener("click", chooseSelected);
      button?.before(fallback);
    }
    const deletion = problem.taskId
      ? (await getTaskDeletionScope(problem.taskId)).deletion
      : null;
    if (
      host["_activeProblem"] !== problem ||
      problem.deletionMode === "selected"
    )
      return;
    if (problem.taskId && !deletion?.targets?.length)
      throw new Error("Missing deletion scope");
    problem.deletionTargets = deletion?.targets;
    if (copy)
      copy.textContent = t(
        deletion?.kind === "group"
          ? "analysis.deleteDialog.group"
          : deletion?.kind === "duplicate"
            ? "analysis.deleteDialog.duplicate"
            : "analysis.deleteDialog.text",
        { count: deletion?.targets?.length || 1 },
      );
    if (button) button.disabled = false;
  } catch (error) {
    if (
      host["_activeProblem"] !== problem ||
      problem.deletionMode === "selected"
    )
      return;
    const code = error?.body?.code;
    const key =
      {
        matching_pending: "matchingPending",
        matching_unavailable: "matchingUnavailable",
        group_changed: "groupChanged",
        group_too_large: "groupTooLarge",
        already_deleted: "alreadyDeleted",
      }[code] || "loadError";
    if (copy)
      copy.textContent =
        t(`analysis.deleteDialog.${key}`) +
        (selected ? " " + t("analysis.deleteDialog.selectedAvailable") : "");
    if (code === "already_deleted" || error?.status === 404) {
      if (button) button.hidden = true;
      host.querySelector("[data-delete-selected]")?.remove();
      if (copy) copy.textContent = t("analysis.deleteDialog.alreadyDeleted");
      const refresh = document.createElement("button");
      refresh.type = "button";
      refresh.className =
        "btn-outline analysis-dialog__button analysis-dialog__button--outline";
      refresh.dataset.deleteSelected = "";
      refresh.textContent = t("analysis.deleteDialog.refresh");
      refresh.addEventListener("click", () => window.location.reload());
      button?.before(refresh);
    }
  }
}
