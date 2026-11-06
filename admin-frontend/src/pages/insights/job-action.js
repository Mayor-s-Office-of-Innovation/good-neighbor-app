// One result bar and job flow for every Insights page that makes a file, so
// each shows progress the same way, then a small dialog gives the file.
import { hasKey, t } from "../../../../frontend/src/i18n/i18n.js";
import { escapeHtml } from "../../dom.js";
import { codeKey } from "./insights.templates.js";

/** @typedef {import("./report-job.js").ReportState} ReportState */
/** @typedef {ReturnType<typeof import("./report-job.js").createReportJobs>} ReportJobs */
/**
 * @typedef {{ busy: string, done: string, errors: string, refreshFailed: string }} JobWords
 * i18n keys: the busy button, the ready title, the error prefix and a failed fresh link
 */

const BUSY = new Set(["starting", "queued", "running"]);

/** @param {ReportState | null} job */
const busyOf = (job) => !!job && BUSY.has(job.phase);

/**
 * A grid with equal outer columns, so the count stays centred as words change.
 * @param {{ start: string, end: string }} parts Sort or Group by, then the page's action
 */
export function resultBarView({ start, end }) {
  return `<div class="insights__resultbar">
    <div class="insights__bar-start">${start}</div>
    <div class="insights__bar-mid">
      <p role="status" id="insights-count" class="insights__bar-count" tabindex="-1"></p>
      <p class="muted insights__interval" data-insights-interval></p>
    </div>
    <div class="insights__bar-end">${end}</div>
  </div>`;
}

/**
 * aria-disabled, not disabled, so hover and focus can still say why it's off.
 * @param {string} id
 * @param {string} label
 * @param {string} [kind] a .btn-* class
 */
export function jobButtonView(id, label, kind = "btn-primary") {
  return `<span class="insights__why-wrap"><button type="button" class="${kind}" id="${id}" aria-disabled="true" aria-describedby="${id}-why">${escapeHtml(label)}</button><span role="tooltip" class="insights__why" id="${id}-why"></span><span role="status" class="visually-hidden" id="${id}-status" data-job-status></span></span>`;
}

/**
 * @param {string} id the button's ID
 * @param {ReportState} job a finished one
 * @param {JobWords} words
 */
export function jobDoneView(id, job, words) {
  const ok = job.phase === "succeeded";
  const key = codeKey(words.errors, job.error || "generic");
  const title = ok
    ? t(words.done)
    : t(hasKey(key) ? key : `${words.errors}.generic`);
  // A plain link, so the browser downloads the file without leaving the page.
  const action = ok
    ? `<a class="btn-primary" id="${id}-download" href="${escapeHtml(job.job?.downloadUrl ?? "")}">${escapeHtml(t("admin.insights.job.download"))}</a>`
    : `<button class="btn-primary" value="retry" id="${id}-retry">${escapeHtml(t("common.retry"))}</button>`;
  const failed =
    ok && job.error
      ? `<p class="places-modal__text error">${escapeHtml(t(words.refreshFailed))}</p>`
      : "";
  return `<dialog id="${id}-done" class="places-modal insights__job-done" aria-labelledby="${id}-done-title">
    <form class="places-modal__card" method="dialog">
      <div class="places-modal__copy">
        <h2 class="places-modal__title" id="${id}-done-title"${ok ? "" : ` data-job-error="${escapeHtml(job.error)}"`}>${escapeHtml(title)}</h2>${failed}
      </div>
      <div class="places-modal__actions">
        <button class="btn-outline" value="close">${escapeHtml(t("common.close"))}</button>
        ${action}
      </div>
    </form>
  </dialog>`;
}

/** Draws one page's job button and its ready dialog from the session's job store. */
export class JobAction {
  /**
   * @param {HTMLElement} host
   * @param {{ id: string, jobs: ReportJobs, words: JobWords }} options
   */
  constructor(host, { id, jobs, words }) {
    this.host = host;
    this.id = id;
    this.jobs = jobs;
    this.words = words;
    this.dialogMarkup = "";
    // Capture runs before the page's own click handlers on the same host.
    host.addEventListener("click", this.blocked, true);
    host.addEventListener("click", this.clicked);
  }

  destroy() {
    this.host.removeEventListener("click", this.blocked, true);
    this.host.removeEventListener("click", this.clicked);
    this.dialog()?.remove();
  }

  button() {
    return /** @type {HTMLButtonElement | null} */ (
      this.host.querySelector(`#${this.id}`)
    );
  }

  /** @returns {HTMLDialogElement | null} */
  dialog() {
    return this.host.querySelector(`#${this.id}-done`);
  }

  off() {
    return this.button()?.getAttribute("aria-disabled") === "true";
  }

  /**
   * An aria-disabled button still fires click, so the click stops here.
   * @param {MouseEvent} event
   */
  blocked = (event) => {
    const button = this.button();
    if (!button || !this.off()) return;
    if (!button.contains(/** @type {Node} */ (event.target))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  /** @param {{ label: string, off: boolean, why: string }} view why the button is off, or "" */
  draw({ label, off, why }) {
    const job = this.jobs.current;
    const busy = busyOf(job);
    // Polling goes on, so the spinner stays; the words say reads are failing.
    const stuck = busy && !!job?.error;
    const busyWords = t(
      stuck ? "admin.insights.job.cantCheck" : this.words.busy,
    );
    const button = this.button();
    if (button) {
      const markup = busy
        ? `<wa-spinner aria-hidden="true"></wa-spinner> ${escapeHtml(busyWords)}`
        : escapeHtml(label);
      // Same words, same nodes, so a status poll doesn't restart the spinner.
      if (button.dataset.markup !== markup) {
        button.dataset.markup = markup;
        button.innerHTML = markup;
      }
      button.setAttribute("aria-disabled", String(busy || off));
    }
    const tip = this.host.querySelector(`#${this.id}-why`);
    if (tip) tip.textContent = busy ? "" : why;
    const status = this.host.querySelector(`#${this.id}-status`);
    const said = stuck ? busyWords : "";
    if (status && status.textContent !== said) status.textContent = said;
    this.drawDialog(job);
  }

  /** @param {ReportState | null} job */
  drawDialog(job) {
    let dialog = this.dialog();
    if (!job || busyOf(job)) {
      // A dialog for an earlier run would retry or dismiss the new one.
      if (dialog) this.dropDialog(dialog);
      return;
    }
    const markup = jobDoneView(this.id, job, this.words);
    if (dialog && markup === this.dialogMarkup) return;
    this.dialogMarkup = markup;
    const template = document.createElement("template");
    template.innerHTML = markup;
    const fresh = /** @type {HTMLDialogElement} */ (
      template.content.firstElementChild
    );
    if (dialog) {
      // In place, so the open modal keeps its place on screen.
      const had = dialog.contains(document.activeElement);
      dialog.replaceChildren(...fresh.childNodes);
      if (had)
        /** @type {HTMLElement | null} */ (
          dialog.querySelector(".places-modal__actions > :last-child")
        )?.focus();
      return;
    }
    this.host.append(fresh);
    dialog = fresh;
    dialog.addEventListener("close", this.closed);
    dialog.showModal();
  }

  /** @param {HTMLDialogElement} dialog */
  dropDialog(dialog) {
    const had = dialog.contains(document.activeElement);
    dialog.removeEventListener("close", this.closed);
    dialog.remove();
    this.dialogMarkup = "";
    if (had) this.button()?.focus();
  }

  /** @param {Event} event */
  closed = (event) => {
    const dialog = /** @type {HTMLDialogElement} */ (event.target);
    const retry = dialog.returnValue === "retry";
    dialog.remove();
    this.dialogMarkup = "";
    if (retry) void this.jobs.retry();
    else this.jobs.dismiss();
    this.button()?.focus();
  };

  /** @param {MouseEvent} event */
  clicked = async (event) => {
    const link = /** @type {Element} */ (event.target).closest?.(
      `#${this.id}-download`,
    );
    if (!link) return;
    if (this.jobs.linkFresh()) {
      this.dialog()?.close("download");
      return;
    }
    // A signed link lasts minutes; an old one would fail, so get a new one first.
    event.preventDefault();
    await this.jobs.refresh();
    if (this.jobs.linkFresh())
      /** @type {HTMLElement | null} */ (
        this.host.querySelector(`#${this.id}-download`)
      )?.click();
  };
}
