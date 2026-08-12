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
    const checks = (await getChecksForSite(this._site.id)).sort((a, b) =>
      (b.submittedAt || "").localeCompare(a.submittedAt || ""),
    );
    const submitted = checks.filter((c) => c.status === "submitted");
    const todayCount = submitted.filter((c) => isToday(c.submittedAt)).length;
    const streakDays = new Set(submitted.map((c) => dayKey(c.submittedAt)))
      .size;
    const due = todayCount < CADENCE;

    this.innerHTML = due
      ? this._dueView({ todayCount, streakDays, last: submitted[0] })
      : this._upToDateView({ recent: submitted.slice(0, 6), streakDays });

    const start = this.querySelector("#start-check");
    if (start) {
      start.addEventListener("click", () => {
        startCheck(this._site.id);
        navigate("/check");
      });
    }
  }

  _streak({ todayCount, streakDays }) {
    // Streak bars: today's completed slots filled, remaining hollow. Shape carries
    // the meaning (filled/hollow) so faint color is only reinforcement (a11y).
    const bars = Array.from(
      { length: CADENCE },
      (_, i) =>
        html`<span
          class="streak__bar ${i < todayCount ? "is-done" : ""}"
          aria-hidden="true"
        ></span>`,
    ).join("");
    return html`
      <section class="card streak" aria-label="Check streak">
        <div class="streak__head">
          <span class="streak__label">Streak · ${CADENCE} checks a day</span>
          <span class="streak__count"
            >${streakDays} ${streakDays === 1 ? "day" : "days"}</span
          >
        </div>
        <div class="streak__bars">${bars}</div>
        <p class="hint">${todayCount} of ${CADENCE} today</p>
      </section>
    `;
  }

  _lastLine(last) {
    if (!last) return "";
    const n = (last.findings || []).length;
    const summary =
      n === 0
        ? "All clear last check"
        : `${n} finding${n === 1 ? "" : "s"} last check`;
    return html`
      <a class="rowlink" href="/results">
        <span>${summary}</span>
        <wa-icon name="chevron-right" aria-hidden="true"></wa-icon>
        <span class="visually-hidden">View results</span>
      </a>
    `;
  }

  _dueView({ todayCount, streakDays, last }) {
    return html`
      <div class="stack view-today">
        <p class="eyebrow">
          Last check
          ${last && isToday(last.submittedAt)
            ? escapeHtml(timeOf(last.submittedAt))
            : "—"}
        </p>
        <section class="card status-block">
          <p class="status-block__eyebrow">Perimeter status</p>
          <h2 class="status-block__headline">Check due now</h2>
          <p class="hint">
            Walk the site perimeter and document current conditions. Report
            clean conditions too.
          </p>
          <wa-button
            id="start-check"
            variant="neutral"
            appearance="accent"
            size="large"
            class="cta"
          >
            Start check
          </wa-button>
          <p class="hint status-block__meta">
            Evening window · about 4 minutes
          </p>
        </section>
        ${this._streak({ todayCount, streakDays })} ${this._lastLine(last)}
      </div>
    `;
  }

  _upToDateView({ recent, streakDays }) {
    const clear = recent.filter((c) => (c.findings || []).length === 0).length;
    const withFindings = recent.length - clear;
    const openItems = recent
      .flatMap((c) =>
        (c.findings || [])
          .filter((f) => f.hazard)
          .map((f) => ({ ...f, checkAt: c.submittedAt })),
      )
      .slice(0, 5);

    return html`
      <div class="stack view-today">
        <section class="card status-block">
          <p class="status-block__eyebrow">Perimeter status</p>
          <h2 class="status-block__headline">Up to date</h2>
          <p class="hint">
            All of today's checks are in. Next window opens tomorrow morning.
          </p>
          <p class="summary-line">
            <strong
              >Last ${recent.length}
              check${recent.length === 1 ? "" : "s"}:</strong
            >
            ${clear} clear · ${withFindings} with findings
          </p>
        </section>
        <section class="card">
          <div class="tabs" role="tablist" aria-label="Home sections">
            <button class="tab" role="tab" aria-selected="true">
              Open items
            </button>
            <button
              class="tab"
              role="tab"
              aria-selected="false"
              disabled
              title="Coming soon"
            >
              History
            </button>
          </div>
          ${openItems.length
            ? html`<ul class="openitems">
                ${openItems.map((o) => this._openItem(o)).join("")}
              </ul>`
            : html`<p class="empty">No open items. Nice work.</p>`}
        </section>
        ${this._streak({ todayCount: CADENCE, streakDays })}
      </div>
    `;
  }

  _openItem(o) {
    return html`
      <li class="openitem">
        <div class="openitem__body">
          <p class="openitem__title">${escapeHtml(o.category)}</p>
          <p class="hint">
            ${o.side ? escapeHtml(o.side) + " side · " : ""}Report to the city
            (311)
          </p>
        </div>
        <wa-badge variant="danger" appearance="outlined">Hazard</wa-badge>
      </li>
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
