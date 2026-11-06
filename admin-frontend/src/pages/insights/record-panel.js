// The record side panel, for Raw data lists and Site insights. It opens
// over the list, so the list keeps its place, rows and focus.
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { adminApi } from "../../services/admin-api.js";
import { carriedQuery } from "./insights-routes.js";
import { sessionOf } from "./insights-session.js";
import { loadingView } from "./insights.templates.js";
import { closeOnBackdrop } from "./modal-backdrop.js";
import { plainClick } from "./overview-rules.js";
import { hopKey, panelFrom, recordHref } from "./record-links.js";
import { readRecordPhotos, showRecordPhotos } from "./record-photos.js";
import {
  checkBodyView,
  issueBodyView,
  panelTrailView,
  panelView,
  recordFailedView,
  recordHeadView,
  recordName,
} from "./record.templates.js";

/** @typedef {import("./record-links.js").Hop} Hop */

// Marks this history entry, so only browser Back to it restores the page as it was left.
export const markWayBack = () =>
  history.replaceState({ ...history.state, insightsReturn: true }, "");

/**
 * Whether the page was reached by browser Back or a record's crumb, so it
 * shows what it showed before. Reading it uses up the crumb's mark.
 * @param {{ returning: string }} session
 * @param {string} here
 */
export function cameBack(session, here) {
  const back =
    Boolean(history.state?.insightsReturn) || session.returning === here;
  session.returning = "";
  return back;
}

/** @param {Element} link @returns {Hop | null} */
export function hopOf(link) {
  const kind = link.getAttribute("data-panel-kind");
  const id = link.getAttribute("data-panel-id");
  const siteId = link.getAttribute("data-panel-site");
  return (kind === "issue" || kind === "check") && id && siteId
    ? { kind, id, siteId }
    : null;
}

/** @param {Hop} hop */
const linkSelector = (hop) =>
  `[data-panel-kind="${hop.kind}"][data-panel-id="${CSS.escape(hop.id)}"][data-panel-site="${CSS.escape(hop.siteId)}"]`;

/** @param {Element} dialog @returns {HTMLElement | undefined} a "?" tip open in it */
function openTip(dialog) {
  return /** @type {HTMLElement[]} */ ([
    ...dialog.querySelectorAll("[popover]"),
  ]).find((tip) => {
    try {
      return tip.matches(":popover-open");
    } catch {
      return false;
    }
  });
}

export class RecordPanel {
  /**
   * @param {HTMLElement} host the page the dialog goes in
   * @param {{ fullLabel: string, back: () => string, siteId?: string, left?: (hop: Hop) => void }} options
   * back: the path a full record's trail returns to; siteId: the Site page it opens on;
   * left: called with the record first opened as the user follows a link out of the panel
   */
  constructor(host, { fullLabel, back, siteId = "", left = () => {} }) {
    this.host = host;
    this.fullLabel = fullLabel;
    this.back = back;
    this.siteId = siteId;
    this.left = left;
    /** @type {Hop | null} */
    this.hop = null;
    /** @type {Hop | null} the record the panel opened on, whose row focus returns to */
    this.first = null;
    /** @type {Hop | null} the Check this Issue was opened from, for the trail back */
    this.from = null;
    /** @type {HTMLElement | null} */
    this.opener = null;
    this.generation = 0;
    this.leaving = false;
  }

  /** @returns {HTMLDialogElement | null} */
  get dialog() {
    return this.host.querySelector("#insights-panel");
  }

  /** @param {Hop} hop @param {HTMLElement} opener focus goes back here on close */
  open(hop, opener) {
    this.dialog?.remove();
    this.opener = opener;
    this.leaving = false;
    this.hop = hop;
    this.first = hop;
    this.from = null;
    this.host.insertAdjacentHTML(
      "beforeend",
      panelView({ kind: hop.kind, full: this.fullLink() }),
    );
    const dialog = /** @type {HTMLDialogElement} */ (this.dialog);
    dialog.addEventListener("click", this.clicked);
    dialog.addEventListener("keydown", this.keyed);
    dialog.addEventListener("close", this.closed);
    closeOnBackdrop(dialog, () => this.close());
    dialog.showModal();
    void this.show();
  }

  close() {
    this.dialog?.close();
  }

  /** Aborts a load in flight; the page calls it as it leaves. */
  destroy() {
    this.controller?.abort();
    this.leaving = true;
    this.dialog?.remove();
  }

  // Only the Check an Issue came from becomes a crumb, so the full record keeps the way back to it.
  fullLink() {
    return {
      href: this.linkTo(
        /** @type {Hop} */ (this.hop),
        this.from ? [this.from] : [],
      ),
      label: this.fullLabel,
    };
  }

  /** @param {Hop} target @param {Hop[]} [via] */
  linkTo(target, via = []) {
    return recordHref(target, {
      search: location.search,
      back: this.back(),
      via,
    });
  }

  /** @param {boolean} [refocus] focus the new record's title, or Retry */
  async show(refocus = false) {
    const dialog = this.dialog;
    if (!dialog) return;
    const hop = /** @type {Hop} */ (this.hop);
    const mine = ++this.generation;
    this.controller?.abort();
    this.controller = new AbortController();
    const { signal } = this.controller;
    dialog.setAttribute("aria-label", t(`admin.insights.panel.${hop.kind}`));
    const full = /** @type {HTMLAnchorElement} */ (
      dialog.querySelector("#insights-panel-full")
    );
    full.setAttribute("href", this.fullLink().href);
    const body = /** @type {HTMLElement} */ (
      dialog.querySelector("[data-panel-body]")
    );
    // The redraw removes the focused link or Retry, so focus waits on the dialog, not the page.
    refocus ||= body.contains(document.activeElement);
    if (refocus) {
      dialog.tabIndex = -1;
      dialog.focus();
    }
    body.innerHTML = loadingView();
    // Started now, so photos don't wait for the record's own reply.
    const photos = readRecordPhotos(this.host, hop, signal);
    /** @type {Record<string, any>} */
    let reply;
    try {
      reply = await (hop.kind === "issue"
        ? adminApi.reportingIssue(hop.id, { siteId: hop.siteId }, signal)
        : adminApi.reportingCheck(hop.id, { siteId: hop.siteId }, signal));
    } catch (err) {
      if (
        mine !== this.generation ||
        /** @type {any} */ (err)?.name === "AbortError"
      )
        return;
      body.innerHTML = recordFailedView(hop.kind, err, "insights-panel-retry");
      if (refocus)
        /** @type {HTMLElement | null} */ (
          body.querySelector("#insights-panel-retry")
        )?.focus();
      return;
    }
    if (mine !== this.generation) return;
    sessionOf(this.host).recordNames.set(
      hopKey(hop),
      recordName(hop.kind, reply),
    );
    const site = reply.site?.siteId ?? hop.siteId;
    const siteHref = `/insights/sites/${encodeURIComponent(site)}${carriedQuery(location.search)}`;
    const trail = this.from
      ? panelTrailView({
          check: this.from,
          checkHref: this.linkTo(this.from),
          issueId: hop.id,
        })
      : "";
    // On that Site's own page, a link to it would go nowhere.
    body.innerHTML = `${trail}${recordHeadView({ kind: hop.kind, id: hop.id, reply, level: 2, siteHref: site === this.siteId ? "" : siteHref })}${
      hop.kind === "issue"
        ? issueBodyView({
            reply,
            checkHref: reply.check
              ? this.linkTo({
                  kind: "check",
                  id: reply.check.checkId,
                  siteId: reply.check.siteId,
                })
              : "",
            level: 3,
            idPrefix: "insights-panel",
          })
        : checkBodyView({
            reply,
            issueHref: (issue) =>
              this.linkTo({
                kind: "issue",
                id: issue.issueId,
                siteId: issue.siteId,
              }),
            level: 3,
          })
    }`;
    if (refocus)
      /** @type {HTMLElement | null} */ (
        body.querySelector("#insights-panel-title")
      )?.focus();
    void showRecordPhotos(body.querySelector("[data-record-photos]"), photos, {
      level: 3,
      signal,
    });
  }

  /** @param {MouseEvent} event */
  clicked = (event) => {
    const target = /** @type {Element} */ (event.target);
    // The redraw below detaches the clicked node, so the page mustn't handle the click as its own.
    if (target.closest("#insights-panel-close")) {
      event.stopPropagation();
      return this.close();
    }
    if (target.closest("#insights-panel-retry")) {
      event.stopPropagation();
      return void this.show(true);
    }
    // A click anywhere on an Issue row opens it, as on the lists; a drag selects text instead.
    const link =
      target.closest("a") ??
      (target.closest("[popover]") || String(document.getSelection?.() ?? "")
        ? null
        : target
            .closest("[data-issue-row]")
            ?.querySelector("[data-record-link]"));
    if (!link || !plainClick(event)) return;
    if (
      link.id === "insights-panel-full" ||
      link.hasAttribute("data-record-site")
    ) {
      // Following the link replaces the page, panel and all, so focus mustn't jump back to the row.
      this.leaving = true;
      this.left(/** @type {Hop} */ (this.first));
      return;
    }
    const hop = hopOf(link);
    if (!hop) return;
    // Within the panel, a record link switches the panel, so the list stays put.
    event.preventDefault();
    event.stopPropagation();
    this.from = panelFrom(this.hop, hop);
    this.hop = hop;
    void this.show(true);
  };

  /** happy-dom and older browsers don't all close a modal on Esc. @param {KeyboardEvent} event */
  keyed = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    // The first Esc closes an open "?" tip only, so the reader keeps the record.
    const tip = this.dialog && openTip(this.dialog);
    if (tip) return tip.hidePopover();
    this.close();
  };

  closed = () => {
    this.controller?.abort();
    this.dialog?.remove();
    const opener = this.opener;
    this.opener = null;
    if (this.leaving || !opener) return;
    // Load more can redraw the list under the panel, so the row is found again.
    const row = opener.isConnected
      ? opener
      : this.first &&
        /** @type {HTMLElement | null} */ (
          this.host.querySelector(linkSelector(this.first))
        );
    row?.focus();
  };
}
