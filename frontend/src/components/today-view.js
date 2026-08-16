/*
  today-view — the home hub (Take 5, screens 5a + 5b).

  One component, two states driven by real data:
    - 5a "Check due now"  : today's cadence (3 checks) isn't complete -> last log + Start.
    - 5b "Up to date"     : all of today's checks are in -> last-6 summary + open items.

  Cadence is a fixed pilot value (3/day, decision #3); overdue/missed states are out
  of v1. Per the MVP design trim (docs/mvp-design-trim-plan.md) the "check due" screen
  is pared to just the last-log summary + a Start button; no streak, no status hero.
  Markup is inline via the `html` tag (barebones screen; split into a .templates.js
  file if it grows — see CLAUDE.md convention).
*/
import { html, escapeHtml } from "../lib/html.js";
import { getSite, getDraft } from "../db.js";
import { listChecks } from "../services/api.js";
import { adaptCheckHeader } from "../domain/check-adapter.js";
import { startCheck, clearCheck } from "../state/check-session.js";
import { navigate } from "../router.js";

const CADENCE = 3; // checks per day (pilot, hardcoded)

function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

class TodayView extends HTMLElement {
  async connectedCallback() {
    this._site = await getSite();

    // Checks are read from the backend on load (AP6) — newest first, adapted to
    // the UI record shape. Online-only: on failure show an error, not a crash.
    let submitted;
    try {
      const { checks } = await listChecks({ limit: 30 });
      submitted = (checks || [])
        .map(adaptCheckHeader)
        .filter((c) => c.status === "submitted")
        .sort((a, b) =>
          (b.submittedAt || "").localeCompare(a.submittedAt || ""),
        );
    } catch (err) {
      console.error("listChecks failed", err);
      this._renderError();
      return;
    }

    const todayCount = submitted.filter((c) => isToday(c.submittedAt)).length;
    const due = todayCount < CADENCE;

    // A resumable in-progress walk (Cancel from /check keeps it) turns the CTA into
    // Resume + "Start over" (docs/mvp-design-trim-plan.md).
    const hasDraft = !!(await getDraft());

    this.innerHTML = due
      ? this._dueView({ last: submitted[0], hasDraft })
      : this._upToDateView({ recent: submitted.slice(0, 6) });

    const start = this.querySelector("#start-check");
    if (start) {
      start.addEventListener("click", () => {
        // Resume just re-opens /check (the draft hydrates there); a fresh start
        // seeds a new in-progress check.
        if (!hasDraft) startCheck(this._site.id);
        navigate("/check");
      });
    }
    const over = this.querySelector("#start-over");
    if (over) {
      over.addEventListener("click", () => {
        clearCheck(); // discard the draft
        startCheck(this._site.id);
        navigate("/check");
      });
    }
  }

  // Global site header: neutral avatar circle + site name. No meta subline
  // (MVP design trim — docs/mvp-design-trim-plan.md). Shared with the
  // up-to-date view.
  _siteHeader() {
    const name = (this._site && this._site.name) || "Your site";
    return html`
      <div class="screen__sec sitehead">
        <span class="sitehead__avatar" aria-hidden="true"></span>
        <div class="sitehead__name">${escapeHtml(name)}</div>
      </div>
    `;
  }

  // Backend unreachable on load. Online-only: surface it with a retry rather than
  // silently degrading (offline is post-MVP; no local read fallback).
  _renderError() {
    this.innerHTML = html`
      <div class="home">
        <div class="screen" role="group" aria-label="Today">
          ${this._siteHeader()}
          <div class="screen__sec lastlog">
            <p class="lastlog__eyebrow">CAN’T REACH THE SERVER</p>
            <h1 class="lastlog__headline">Checks are unavailable</h1>
          </div>
          <div class="screen__sec home-cta">
            <button
              id="retry"
              class="btn-ink btn-ink--block"
              type="button"
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    `;
    this.querySelector("#retry")?.addEventListener("click", () =>
      this.connectedCallback(),
    );
  }

  // "Check due" screen (5a): just the last-log summary + the Start button.
  // The last log is the most recent submitted check, summarized by its worst
  // finding (see _lastLog); with no checks yet it reads "No activity recorded yet".
  _dueView({ last, hasDraft }) {
    const log = this._lastLog(last);
    return html`
      <div class="home">
        <div class="screen screen--due" role="group" aria-label="Today">
          ${this._siteHeader()}
          <div class="screen__sec lastlog">
            ${log.eyebrow
              ? html`<p class="lastlog__eyebrow">
                  ${escapeHtml(log.eyebrow)}
                </p>`
              : ""}
            <h1 class="lastlog__headline">${escapeHtml(log.headline)}</h1>
          </div>
          <div class="screen__sec home-cta">
            <button id="start-check" class="btn-ink btn-ink--block" type="button">
              <wa-icon name="camera" aria-hidden="true"></wa-icon>
              ${hasDraft
                ? "Resume perimeter check"
                : "Start a perimeter check"}
            </button>
            ${hasDraft
              ? html`<button
                  id="start-over"
                  class="home-cta__link"
                  type="button"
                >
                  Start over
                </button>`
              : ""}
          </div>
        </div>
      </div>
    `;
  }

  // Summarize the last submitted check as a one-line activity log:
  //   eyebrow = "LAST LOG · <relative day> · <time>"
  //   headline = "<worst finding category> — <triage status>", or "All clear"
  // No submitted check yet -> no eyebrow, headline "No activity recorded yet".
  _lastLog(last) {
    if (!last || !last.submittedAt) {
      return { eyebrow: "", headline: "No activity recorded yet" };
    }
    const eyebrow = `LAST LOG · ${relativeDay(last.submittedAt)} · ${timeOf(
      last.submittedAt,
    )}`;
    const worst = worstFinding(last.findings || []);
    const headline = worst
      ? `${worst.category || "Finding"} — ${triageStatus(worst)}`
      : "All clear";
    return { eyebrow, headline };
  }

  // Categorize each recent check into one bucket by its worst outcome:
  //   escalated = any city/hazard finding · minor = findings but none hazard · clear = none.
  // Buckets sum to recent.length and drive both the donut and the legend.
  _buckets(recent) {
    let clear = 0,
      minor = 0,
      esc = 0;
    for (const c of recent) {
      const findings = c.findings || [];
      if (findings.some((f) => f.hazard)) esc += 1;
      else if (findings.length) minor += 1;
      else clear += 1;
    }
    return { clear, minor, esc, total: recent.length };
  }

  // Donut: one stroked ring per bucket on a circumference-100 circle, so each
  // segment length IS its percentage. Decorative (aria-hidden) — the legend
  // below states every count in text, so color is never the sole carrier.
  _donut({ clear, minor, esc, total }) {
    const segs = [
      { key: "clear", n: clear },
      { key: "minor", n: minor },
      { key: "esc", n: esc },
    ];
    let cumulative = 0;
    const rings = segs
      .filter((s) => s.n > 0)
      .map((s) => {
        const pct = total ? (s.n / total) * 100 : 0;
        const offset = 25 - cumulative; // start each ring where the last ended
        cumulative += pct;
        return html`<circle
          class="donut__seg donut__seg--${s.key}"
          cx="21"
          cy="21"
          r="15.915"
          stroke-dasharray="${pct.toFixed(2)} ${(100 - pct).toFixed(2)}"
          stroke-dashoffset="${offset.toFixed(2)}"
        ></circle>`;
      })
      .join("");
    return html`
      <svg class="donut" viewBox="0 0 42 42" aria-hidden="true">
        <circle
          class="donut__seg donut__seg--clear"
          cx="21"
          cy="21"
          r="15.915"
          stroke-dasharray="100 0"
          stroke-dashoffset="25"
          opacity="0.12"
        ></circle>
        ${rings}
      </svg>
    `;
  }

  _upToDateView({ recent }) {
    const b = this._buckets(recent);

    // Open work items from the most recent checks, split city (hazard -> 311)
    // vs self-serviceable. NOTE: ticket #, status, and reported-time are not in
    // the findings model yet (post-MVP 311 integration) — rendered here from
    // clearly representative placeholders so the workflow is visible end-to-end.
    const flat = recent.flatMap((c) =>
      (c.findings || []).map((f) => ({ ...f, checkAt: c.submittedAt })),
    );
    const cityItems = flat.filter((f) => f.hazard);
    const handleItems = flat.filter((f) => !f.hazard);

    const cityCards = cityItems
      .map((f, i) =>
        this._actionCard(f, {
          role: "City action",
          ticket: `#SF-${4471 + i}`, // MOCK ticket
          status: i % 2 === 0 ? "route" : "pending", // MOCK lifecycle
          reported: "Reported 12:04 PM", // MOCK time
          confirm: false,
        }),
      )
      .join("");

    const handleCards = handleItems
      .map((f, i) =>
        this._actionCard(f, {
          role: "Yours",
          ticket: `#SF-${4318 + i}`, // MOCK ticket
          status: "confirm",
          reported: "City closed it out — verify it's gone", // MOCK
          confirm: true,
        }),
      )
      .join("");

    return html`
      <div class="home">
        <div class="screen" role="group" aria-label="Today">
          ${this._siteHeader()}
          <div class="screen__sec hero">
            <p class="hero__eyebrow">Perimeter status</p>
            <h1 class="hero__headline">Up to date</h1>
            <p class="hero__body">
              All ${CADENCE} checks in. Next window opens tomorrow morning.
            </p>
          </div>
          <div class="screen__sec stat">
            ${this._donut(b)}
            <div class="stat__summary">
              <p class="stat__label">
                Last ${b.total} check${b.total === 1 ? "" : "s"}
              </p>
              <p class="stat__headline">${b.clear} clear</p>
              <ul class="legend">
                <li class="legend__item">
                  <span class="legend__dot legend__dot--minor"></span>
                  ${b.minor} minor, handled
                </li>
                <li class="legend__item">
                  <span class="legend__dot legend__dot--esc"></span>
                  ${b.esc} escalated to 311
                </li>
              </ul>
            </div>
          </div>
          <div class="screen__sec">
            <div class="segmented" role="tablist" aria-label="Home sections">
              <button
                class="segmented__btn is-active"
                role="tab"
                aria-selected="true"
                type="button"
              >
                Open items
              </button>
              <button
                class="segmented__btn"
                role="tab"
                aria-selected="false"
                type="button"
                disabled
                title="Coming soon"
              >
                History
              </button>
            </div>
          </div>
        </div>

        ${cityItems.length || handleItems.length
          ? html`
              <div class="worklist">
                ${cityItems.length
                  ? html`
                      <div class="worklist__group">
                        <div class="worklist__head">
                          <span class="worklist__title"
                            >City action · ${cityItems.length}</span
                          >
                          <span class="worklist__meta">With 311</span>
                        </div>
                        ${cityCards}
                      </div>
                    `
                  : ""}
                ${handleItems.length
                  ? html`
                      <div class="worklist__group">
                        <div class="worklist__head">
                          <span class="worklist__title"
                            >${handleItems.length} you can handle</span
                          >
                          <span class="worklist__meta">Safe to clear</span>
                        </div>
                        ${handleCards}
                      </div>
                    `
                  : ""}
              </div>
            `
          : html`<p class="empty" style="text-align:center;margin-top:1.25rem">
              No open items. Nice work.
            </p>`}
      </div>
    `;
  }

  // A single work item. `meta` carries the (currently representative) 311
  // lifecycle fields; `confirm` toggles the self-serviceable resolve actions.
  _actionCard(f, meta) {
    const label =
      meta.status === "route"
        ? "En route"
        : meta.status === "pending"
          ? "Pending"
          : "Confirm";
    // Descriptor before the ticket: real side/explanation where we have it,
    // otherwise the representative line supplied by meta.reported.
    const descriptor =
      (f.side && `${escapeHtml(f.side)} side`) ||
      (f.explanation && escapeHtml(f.explanation)) ||
      escapeHtml(meta.reported);
    return html`
      <div class="actioncard">
        <div class="actioncard__head">
          <span class="actioncard__type">${escapeHtml(meta.role)}</span>
          <span class="pill pill--${meta.status}">${label}</span>
        </div>
        <h3 class="actioncard__title">
          ${escapeHtml(f.category || "Finding")}
        </h3>
        <p class="actioncard__detail">
          ${descriptor} · ${escapeHtml(meta.ticket)}
        </p>
        ${meta.confirm
          ? html`
              <div class="actioncard__actions">
                <button class="btn-ink btn-ink--sm" type="button">
                  It's gone
                </button>
                <button class="btn-outline btn-outline--sm" type="button">
                  Still there
                </button>
              </div>
            `
          : html`<p class="actioncard__foot">${escapeHtml(meta.reported)}</p>`}
      </div>
    `;
  }
}

function timeOf(iso) {
  return new Date(iso)
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .replace(/\s/g, "")
    .toUpperCase();
}

// "TODAY" / "YESTERDAY" for the last 2 days, else the uppercase weekday.
function relativeDay(iso) {
  const d = new Date(iso);
  const dStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const ago = Math.round((todayStart.getTime() - dStart.getTime()) / 86400000);
  if (ago <= 0) return "TODAY";
  if (ago === 1) return "YESTERDAY";
  return d.toLocaleDateString([], { weekday: "long" }).toUpperCase();
}

// The check's most notable finding: hazards first, then highest rating.
function worstFinding(findings) {
  if (!findings.length) return null;
  return [...findings].sort(
    (a, b) =>
      Number(b.hazard) - Number(a.hazard) || (b.rating || 0) - (a.rating || 0),
  )[0];
}

// The triage bucket phrase for a finding (mirrors check-results.js buckets):
//   hazard -> city action · non-hazard rating>=2 -> handle · rating 1 -> noted.
function triageStatus(f) {
  if (f.hazard) return "escalated to 311";
  if ((f.rating || 0) >= 2) return "flagged to handle";
  return "noted, no action";
}

customElements.define("today-view", TodayView);
