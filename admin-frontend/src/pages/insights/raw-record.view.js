// <insights-record>: one Issue or Check on its own page, with a trail back
// to the list or Site page it came from and each record walked through.
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { escapeHtml } from "../../dom.js";
import { adminApi } from "../../services/admin-api.js";
import {
  INSIGHTS_ROUTES,
  carriedQuery,
  safeReturnPath,
} from "./insights-routes.js";
import { sessionOf } from "./insights-session.js";
import {
  failedView,
  failureText,
  freshnessView,
  loadingView,
} from "./insights.templates.js";
import { hopKey, readVia, recordHref } from "./record-links.js";
import { showRecordPhotos } from "./record-photos.js";
import {
  checkBodyView,
  issueBodyView,
  recordHeadView,
  recordName,
  recordTrailView,
} from "./record.templates.js";

/** @typedef {import("./record-links.js").Hop} Hop */

/** @param {string} path checked by safeReturnPath @returns {string} its route name */
function routeOf(path) {
  const pathname = path.split("?")[0];
  return (
    INSIGHTS_ROUTES.find(([, pattern]) => pattern.test(pathname))?.[0] ?? ""
  );
}

class InsightsRecord extends HTMLElement {
  connectedCallback() {
    this.session = sessionOf(this);
    /** @type {Hop} */
    this.hop = {
      kind: this.dataset.kind === "check" ? "check" : "issue",
      id: this.dataset.id ?? "",
      siteId: new URLSearchParams(location.search).get("siteId") ?? "",
    };
    const asked = safeReturnPath(
      new URLSearchParams(location.search).get("return"),
    );
    const route = asked ? routeOf(asked) : "";
    // Only a list or Site page is a level the trail can return to.
    this.back = [
      "insights-issues",
      "insights-checks",
      "insights-site",
    ].includes(route)
      ? asked
      : "";
    this.fromSite = route === "insights-site";
    this.via = readVia(location.search);
    /** @type {Record<string, any> | null} */
    this.reply = null;
    this.innerHTML = `
      <div data-region="trail">${this.trailView()}</div>
      <div data-region="head">${this.headView()}</div>
      <div data-region="freshness">${freshnessView(null)}</div>
      <div data-region="body"></div>`;
    this.addEventListener("click", this.clicked);
    void this.load();
  }

  disconnectedCallback() {
    this.controller?.abort();
    this.removeEventListener("click", this.clicked);
  }

  /** @param {string} name @returns {HTMLElement} */
  region(name) {
    return /** @type {HTMLElement} */ (
      this.querySelector(`[data-region="${name}"]`)
    );
  }

  trailView() {
    const listKind = this.back
      ? routeOf(this.back) === "insights-checks"
        ? "checks"
        : "issues"
      : `${this.hop.kind}s`;
    const root = this.fromSite
      ? { href: this.back, label: t("admin.insights.site") }
      : {
          href:
            this.back ||
            `/insights/raw/${listKind}${carriedQuery(location.search)}`,
          label: t(`admin.insights.${listKind}`),
        };
    const names = this.session.recordNames;
    return recordTrailView({
      root,
      raw: `/insights/raw/${listKind}${carriedQuery(location.search)}`,
      fromSite: this.fromSite,
      hops: this.via.map((hop, i) => ({
        href: recordHref(hop, {
          search: location.search,
          back: this.back,
          via: this.via.slice(0, i),
        }),
        label:
          names.get(hopKey(hop)) ??
          t(`admin.insights.${hop.kind}`, { id: hop.id }),
      })),
      // Named as its crumb would be, so one record never shows under two names.
      current:
        names.get(hopKey(this.hop)) ??
        t(`admin.insights.${this.hop.kind}`, { id: this.hop.id }),
    });
  }

  headView() {
    return recordHeadView({
      kind: this.hop.kind,
      id: this.hop.id,
      reply: this.reply,
      level: 1,
      siteHref: this.reply
        ? `/insights/sites/${encodeURIComponent(this.reply.site?.siteId ?? this.hop.siteId)}${carriedQuery(location.search)}`
        : "",
    });
  }

  /** Each hop is its own page, so browser Back steps back one record. @param {Hop} target */
  linkTo(target) {
    return recordHref(target, {
      search: location.search,
      back: this.back,
      via: [...this.via, this.hop],
    });
  }

  async load() {
    this.controller?.abort();
    this.controller = new AbortController();
    const { signal } = this.controller;
    const { kind, id, siteId } = this.hop;
    const params = siteId ? { siteId } : {};
    this.region("body").innerHTML = loadingView();
    this.setAttribute("aria-busy", "true");
    /** @type {Record<string, any>} */
    let reply;
    try {
      reply = await (kind === "issue"
        ? adminApi.reportingIssue(id, params, signal)
        : adminApi.reportingCheck(id, params, signal));
    } catch (err) {
      if (/** @type {any} */ (err)?.name === "AbortError") return;
      this.removeAttribute("aria-busy");
      const code = /** @type {any} */ (err)?.message;
      // Not found and two-Sites replies won't change on a retry.
      this.region("body").innerHTML =
        code === `${kind}_not_found` || code === "site_id_required"
          ? `<p class="empty-state" data-insights-empty="${escapeHtml(code)}">${escapeHtml(t(`admin.insights.record.${code === "site_id_required" ? "needsSite" : "notFound"}.${kind}`))}</p>`
          : failedView(
              failureText(err, t(`admin.insights.record.failed.${kind}`)),
            );
      return;
    }
    this.removeAttribute("aria-busy");
    this.reply = reply;
    this.session.recordNames.set(hopKey(this.hop), recordName(kind, reply));
    this.region("trail").innerHTML = this.trailView();
    this.drawHead();
    this.region("freshness").innerHTML = freshnessView(reply.meta);
    this.region("body").innerHTML =
      kind === "issue"
        ? issueBodyView({
            reply,
            checkHref: reply.check
              ? this.linkTo({
                  kind: "check",
                  id: reply.check.checkId,
                  siteId: reply.check.siteId,
                })
              : "",
            level: 2,
            idPrefix: "insights-record",
          })
        : checkBodyView({
            reply,
            issueHref: (issue) =>
              this.linkTo({
                kind: "issue",
                id: issue.issueId,
                siteId: issue.siteId,
              }),
            level: 2,
          });
    void showRecordPhotos(
      this.querySelector("[data-record-photos]"),
      { kind, id, siteId: reply.site?.siteId ?? siteId, level: 2 },
      signal,
    );
  }

  drawHead() {
    const focused = document.activeElement?.id === "insights-title";
    this.region("head").innerHTML = this.headView();
    // The dashboard focused the placeholder heading on arrival.
    if (focused)
      /** @type {HTMLElement} */ (this.querySelector("#insights-title")).focus({
        preventScroll: true,
      });
  }

  /** @param {Event} event */
  clicked = (event) => {
    const target = /** @type {Element} */ (event.target);
    // The list or Site page keeps its rows only for a way back, not a fresh visit.
    const back = target.closest("[data-crumb='root'], [data-crumb-back]");
    if (back) this.session.returning = back.getAttribute("href") ?? "";
    const button = target.closest("button");
    if (button?.id === "insights-retry" && this.contains(button))
      void this.load();
    // A click anywhere on an Issue row opens it, as on the lists.
    if (!target.closest("a, button, [popover]"))
      /** @type {HTMLElement | null | undefined} */ (
        target.closest("[data-issue-row]")?.querySelector("[data-record-link]")
      )?.click();
  };
}

if (!customElements.get("insights-record"))
  customElements.define("insights-record", InsightsRecord);
