/*
  today-view — the home hub (Take 5, screens 5a + 5b).

  One component, two states driven by real data:
    - 5a "Check due now"  : today's cadence (3 checks) isn't complete -> Start check.
    - 5b "Up to date"     : all of today's checks are in -> last-6 summary + open items.

  Cadence is a fixed pilot value (3/day, decision #3); overdue/missed states are out
  of v1. The streak is kept but restrained (decision #4) — motivational count only, no
  points/badges/pressure. Markup is inline via the `html` tag (barebones screen; split
  into a .templates.js file if it grows — see CLAUDE.md convention).
*/
import { html, escapeHtml } from "../lib/html.js";
import { getSite, getChecksForSite } from "../db.js";
import { startCheck } from "../state/check-session.js";
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

function dayKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

class TodayView extends HTMLElement {
  async connectedCallback() {
    this._site = await getSite();
    this._siteId = this._site.siteId || this._site.id;
    const checks = (await getChecksForSite(this._siteId)).sort((a, b) =>
      (b.submittedAt || "").localeCompare(a.submittedAt || ""),
    );
    const submitted = checks.filter((c) => c.status === "submitted");
    const todayCount = submitted.filter((c) => isToday(c.submittedAt)).length;
    const streakDays = new Set(submitted.map((c) => dayKey(c.submittedAt)))
      .size;
    const due = todayCount < CADENCE;

    this.innerHTML = due
      ? this._dueView({ streakDays, last: submitted[0], submitted })
      : this._upToDateView({ recent: submitted.slice(0, 6) });

    const start = this.querySelector("#start-check");
    if (start) {
      start.addEventListener("click", () => {
        startCheck(this._siteId);
        navigate("/check");
      });
    }
  }

  // Per-day submitted-check counts for the last `days` days, oldest first,
  // last element = today. Feeds the streak sparkline.
  _dayCounts(submitted, days) {
    const counts = new Array(days).fill(0);
    const now = new Date();
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );
    for (const c of submitted) {
      if (!c.submittedAt) continue;
      const d = new Date(c.submittedAt);
      const dStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const ago = Math.round(
        (todayStart.getTime() - dStart.getTime()) / 86400000,
      );
      const idx = days - 1 - ago;
      if (idx >= 0 && idx < days) counts[idx] += 1;
    }
    return counts;
  }

  // Site header: seal + name + last-check time. Seal is a placeholder wa-icon
  // until the optimized SF-seal PNG lands (see MVP-TODO go-live item).
  _siteHeader(last) {
    const name = (this._site && this._site.name) || "Your site";
    const meta =
      last && isToday(last.submittedAt)
        ? `Last check: ${timeOf(last.submittedAt)}`
        : "No check yet today";
    return html`
      <div class="screen__sec sitehead">
        <span class="sitehead__seal" aria-hidden="true">
          <wa-icon name="location-dot"></wa-icon>
        </span>
        <div>
          <div class="sitehead__name">${escapeHtml(name)}</div>
          <p class="sitehead__meta">${escapeHtml(meta)}</p>
        </div>
      </div>
    `;
  }

  // Multi-day compliance sparkline: one bar per day, height = checks/cadence.
  // Full days solid, partial days a solid faint fill (1.4.11 non-text 3:1),
  // today a dashed outline. Bars are decorative; the count + axis carry meaning.
  _sparkline(submitted, streakDays) {
    const counts = this._dayCounts(submitted, 14);
    const bars = counts
      .map((n, i) => {
        const today = i === counts.length - 1;
        const pct =
          n === 0 ? 8 : Math.round((Math.min(n, CADENCE) / CADENCE) * 100);
        const cls = today
          ? "spark__bar spark__bar--today"
          : n >= CADENCE
            ? "spark__bar"
            : "spark__bar spark__bar--partial";
        return html`<div
          class="${cls}"
          style="height:${today ? 100 : pct}%"
        ></div>`;
      })
      .join("");

    const start = new Date();
    start.setDate(start.getDate() - (counts.length - 1));
    const startLabel = start.toLocaleDateString([], {
      month: "short",
      day: "numeric",
    });

    return html`
      <div class="screen__sec">
        <div class="streakhead">
          <span class="streakhead__label"
            >Streak · ${CADENCE} checks a day</span
          >
          <span class="streakhead__count"
            >${streakDays} ${streakDays === 1 ? "day" : "days"}</span
          >
        </div>
        <div class="spark">
          <div class="spark__guide"><span>${CADENCE} of ${CADENCE}</span></div>
          <div class="spark__bars" aria-hidden="true">${bars}</div>
        </div>
        <div class="spark__axis">
          <span>${escapeHtml(startLabel)}</span><span>today</span>
        </div>
      </div>
    `;
  }

  // City-actions footer: split last check's findings into city-owned (hazards)
  // vs self-serviceable. Hidden when the last check had no findings.
  _footer(last) {
    const findings = (last && last.findings) || [];
    if (!findings.length) return "";
    const city = findings.filter((f) => f.hazard).length;
    const handle = findings.length - city;
    const parts = [];
    if (city) parts.push(`${city} city action${city === 1 ? "" : "s"}`);
    if (handle) parts.push(`${handle} you can handle`);
    return html`
      <div class="screen__sec cityfoot">
        <span class="cityfoot__text">${parts.join(" · ")}</span>
        <a class="cityfoot__link" href="/results">View</a>
      </div>
    `;
  }

  _dueView({ streakDays, last, submitted }) {
    return html`
      <div class="home">
        <div class="screen" role="group" aria-label="Today">
          ${this._siteHeader(last)}
          <div class="screen__sec hero">
            <p class="hero__eyebrow">Perimeter status</p>
            <h1 class="hero__headline">Check due now</h1>
            <p class="hero__body">
              Walk the site perimeter and document current conditions. Report
              clean conditions too.
            </p>
            <button id="start-check" class="btn-ink" type="button">
              Start Perimeter Check
            </button>
            <p class="hero__meta">Window closes 7:00 PM · about 4 minutes</p>
          </div>
          ${this._sparkline(submitted, streakDays)} ${this._footer(last)}
        </div>
      </div>
    `;
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
          ${this._siteHeader(recent[0])}
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
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

customElements.define("today-view", TodayView);
