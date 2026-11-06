// The record side panel, for Raw data lists and Site insights. It opens
// over the list, so the list keeps its place, rows and focus.
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { adminApi } from "../../services/admin-api.js";
import { carriedQuery } from "./insights-routes.js";
import { sessionOf } from "./insights-session.js";
import { failedView, failureText, loadingView } from "./insights.templates.js";
import { hopKey, recordHref } from "./record-links.js";
import { showRecordPhotos } from "./record-photos.js";
import {
  checkBodyView,
  issueBodyView,
  panelTrailView,
  panelView,
  recordHeadView,
  recordName,
} from "./record.templates.js";

/** @typedef {import("./record-links.js").Hop} Hop */

/** A plain left click; any other opens the link's own address, as links do. @param {MouseEvent} event */
export const plainClick = (event) =>
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey;

/** @param {Element} link @returns {Hop | null} */
export function hopOf(link) {
  const kind = link.getAttribute("data-panel-kind");
  const id = link.getAttribute("data-panel-id");
  const siteId = link.getAttribute("data-panel-site");
  return (kind === "issue" || kind === "check") && id && siteId
    ? { kind, id, siteId }
    : null;
}

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

/** @param {Element} box @param {MouseEvent} event */
function outside(box, event) {
  const r = box.getBoundingClientRect();
  return (
    event.clientX < r.left ||
    event.clientX > r.right ||
    event.clientY < r.top ||
    event.clientY > r.bottom
  );
}

export class RecordPanel {
  /**
   * @param {HTMLElement} host the page the dialog goes in
   * @param {{ fullLabel: string, back: () => string, siteId?: string, left?: (hop: Hop) => void }} options
   * back: the path a full record's trail returns to; siteId: the Site page it opens on;
   * left: called as the user follows a link out of the panel
   */
  constructor(host, { fullLabel, back, siteId = "", left = () => {} }) {
    this.host = host;
    this.fullLabel = fullLabel;
    this.back = back;
    this.siteId = siteId;
    this.left = left;
    /** @type {Hop | null} */
    this.hop = null;
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
    this.from = null;
    this.host.insertAdjacentHTML(
      "beforeend",
      panelView({ kind: hop.kind, full: this.fullLink() }),
    );
    const dialog = /** @type {HTMLDialogElement} */ (this.dialog);
    dialog.addEventListener("click", this.clicked);
    dialog.addEventListener("keydown", this.keyed);
    dialog.addEventListener("close", this.closed);
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

  async show() {
    const dialog = this.dialog;
    if (!dialog) return;
    const hop = /** @type {Hop} */ (this.hop);
    const mine = ++this.generation;
    this.controller?.abort();
    this.controller = new AbortController();
    dialog.setAttribute("aria-label", t(`admin.insights.panel.${hop.kind}`));
    const full = /** @type {HTMLAnchorElement} */ (
      dialog.querySelector("#insights-panel-full")
    );
    full.setAttribute("href", this.fullLink().href);
    const body = /** @type {HTMLElement} */ (
      dialog.querySelector("[data-panel-body]")
    );
    body.innerHTML = loadingView();
    /** @type {Record<string, any>} */
    let reply;
    try {
      reply = await (hop.kind === "issue"
        ? adminApi.reportingIssue(
            hop.id,
            { siteId: hop.siteId },
            this.controller.signal,
          )
        : adminApi.reportingCheck(
            hop.id,
            { siteId: hop.siteId },
            this.controller.signal,
          ));
    } catch (err) {
      if (
        mine !== this.generation ||
        /** @type {any} */ (err)?.name === "AbortError"
      )
        return;
      body.innerHTML = failedView(
        failureText(err, t(`admin.insights.record.failed.${hop.kind}`)),
        "insights-panel-retry",
      );
      return;
    }
    if (mine !== this.generation) return;
    sessionOf(this.host).recordNames.set(
      hopKey(hop),
      recordName(hop.kind, reply),
    );
    const siteHref = `/insights/sites/${encodeURIComponent(reply.site?.siteId ?? hop.siteId)}${carriedQuery(location.search)}`;
    // On that Site's own page, a link to it would go nowhere.
    const site = reply.site?.siteId ?? hop.siteId;
    const trail = this.from
      ? panelTrailView({
          check: this.from,
          checkHref: this.linkTo(this.from),
          issueId: hop.id,
        })
      : "";
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
    void showRecordPhotos(
      body.querySelector("[data-record-photos]"),
      { kind: hop.kind, id: hop.id, siteId: site, level: 3 },
      this.controller.signal,
    );
  }

  /** @param {MouseEvent} event */
  clicked = (event) => {
    const dialog = this.dialog;
    const target = /** @type {Element} */ (event.target);
    // Short records leave the dialog itself showing inside the panel, so only a click outside its box is on the backdrop.
    if (target === dialog && outside(dialog, event)) return this.close();
    // The redraw below detaches the clicked node, so the page mustn't handle the click as its own.
    if (target.closest("#insights-panel-close")) {
      event.stopPropagation();
      return this.close();
    }
    if (target.closest("#insights-panel-retry")) {
      event.stopPropagation();
      return void this.show();
    }
    // A click anywhere on an Issue row opens it, as on the lists.
    const link =
      target.closest("a") ??
      (target.closest("[popover]")
        ? null
        : target
            .closest("[data-issue-row]")
            ?.querySelector("[data-record-link]"));
    if (!link || !plainClick(event)) return;
    if (
      link.id === "insights-panel-full" ||
      link.hasAttribute("data-record-site")
    ) {
      // The app navigates and the page goes, panel and all; focus mustn't jump back to the row.
      this.leaving = true;
      this.left(/** @type {Hop} */ (this.hop));
      return;
    }
    const hop = hopOf(link);
    if (!hop) return;
    // Within the panel, a record link switches the panel, so the list stays put.
    event.preventDefault();
    event.stopPropagation();
    // An Issue reached from a Check keeps that Check, so the trail leads back.
    this.from =
      hop.kind === "issue" && this.hop?.kind === "check" ? this.hop : null;
    this.hop = hop;
    void this.show().then(() =>
      /** @type {HTMLElement | null | undefined} */ (
        this.dialog?.querySelector("#insights-panel-title")
      )?.focus(),
    );
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
    if (opener.isConnected) opener.focus();
  };
}
