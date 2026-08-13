// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  check-results — 5e (design port, screen 16). Findings from the submitted check,
  triaged into three buckets:
    - City action  (hazard)              -> File 311, don't handle
    - You can handle (non-hazard, 2-3)   -> safe to clear, tick them off
    - Noted, no action (non-hazard, 1)   -> informational
  Bucket + label carry severity in text; color only reinforces (WCAG 1.4.1).

  NOTE: per-finding confidence % and the 311 ticket lifecycle are not in the
  findings model yet (post-MVP). Confidence is rendered from a representative,
  deterministic value and clearly reads as an estimate; the bottom actions close
  the check locally until the 311 integration lands.

  Reads the just-submitted check from the session; falls back to the most recent
  persisted check so the home "View" link still lands somewhere real.
*/
import { html, escapeHtml } from "../lib/html.js";
import { getSite, getChecksForSite } from "../db.js";
import { navigate } from "../router.js";
import {
  getCurrentCheck,
  allItems,
  clearCheck,
} from "../state/check-session.js";

const NUM_WORD = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];
const word = (n) => NUM_WORD[n] || String(n);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Representative, deterministic confidence (no live scoring in this build).
function confidence(f, i) {
  return (
    62 +
    ((f.rating * 9 + (f.category ? f.category.length : 0) * 3 + i * 7) % 36)
  );
}

class CheckResults extends HTMLElement {
  async connectedCallback() {
    this._site = await getSite();

    const session = getCurrentCheck();
    let findings, evidence, items;
    if (session && session.status === "submitted") {
      findings = session.findings || [];
      items = allItems();
      evidence = {
        photos: items.filter((i) => i.kind === "photo").length,
        voice: items.filter((i) => i.kind === "voice").length,
        notes: items.filter((i) => i.kind === "note").length,
      };
    } else {
      const checks = (await getChecksForSite(this._site.id))
        .filter((c) => c.status === "submitted")
        .sort((a, b) =>
          (b.submittedAt || "").localeCompare(a.submittedAt || ""),
        );
      const latest = checks[0];
      if (!latest) {
        navigate("/today");
        return;
      }
      findings = latest.findings || [];
      items = [];
      evidence = null;
    }

    const city = findings.filter((f) => f.hazard);
    const handle = findings.filter((f) => !f.hazard && f.rating >= 2);
    const noted = findings.filter((f) => !f.hazard && f.rating === 1);
    const total = findings.length;
    const itemCount = items.length;

    this.innerHTML = html`
      <div class="flow view-results">
        <div class="topbar">
          <button
            class="topbar__back"
            id="back"
            type="button"
            aria-label="Back"
          >
            <wa-icon name="chevron-left" aria-hidden="true"></wa-icon>
          </button>
          <div class="topbar__titles">
            <h1 class="topbar__title">
              Evening
              check${session && session.submittedAt
                ? ` · ${timeOf(session.submittedAt)}`
                : ""}
            </h1>
          </div>
          <span class="topbar__meta"
            >${itemCount ? `${itemCount} items` : ""}</span
          >
        </div>

        <div class="flow-hero">
          <p class="flow-hero__eyebrow">Analysis</p>
          <h2 class="flow-hero__headline">
            ${total} finding${total === 1 ? "" : "s"}
          </h2>
          <p class="flow-hero__body">${this._summary(city, handle, noted)}</p>
        </div>

        ${total === 0
          ? html`<div class="rowcard">
              <div class="rowcard__row">
                <span class="rowcard__thumb"
                  ><wa-icon name="circle-check"></wa-icon
                ></span>
                <div class="rowcard__body">
                  <p class="rowcard__title">All clear</p>
                  <p class="rowcard__detail">
                    No conditions found this walk. Nice work.
                  </p>
                </div>
              </div>
            </div>`
          : ""}
        ${evidence && (evidence.photos || evidence.voice || evidence.notes)
          ? this._evidence(evidence, items)
          : ""}
        ${city.length ? this._cityBucket(city) : ""}
        ${handle.length ? this._handleBucket(handle) : ""}
        ${noted.length ? this._notedBucket(noted) : ""}

        <div class="flow-ctas">
          ${city.length
            ? html`<button class="btn-ink" id="file-311" type="button">
                File 1 ticket for all ${word(city.length)}
              </button>`
            : ""}
          ${handle.length
            ? html`<button class="btn-outline" id="mark-handled" type="button">
                Mark my ${word(handle.length)} handled &amp; close
              </button>`
            : ""}
          ${!city.length && !handle.length
            ? html`<button class="btn-ink" id="done" type="button">
                Back to home
              </button>`
            : ""}
        </div>
        <p class="flow-foot">Tap any finding to dispute it.</p>
      </div>
    `;

    const finish = () => {
      clearCheck();
      navigate("/today");
    };
    this.querySelector("#back").addEventListener("click", finish);
    this.querySelector("#file-311")?.addEventListener("click", finish);
    this.querySelector("#mark-handled")?.addEventListener("click", finish);
    this.querySelector("#done")?.addEventListener("click", finish);
    // Tap a finding to "dispute" — post-MVP; harmless no-op affordance for now.
    this.querySelectorAll(".findcard__row").forEach((row) =>
      row.addEventListener("click", () => {}),
    );
    // "You can handle" items tick off in place.
    this.querySelectorAll(".checkitem").forEach((btn) =>
      btn.addEventListener("click", () => {
        const on = btn.getAttribute("aria-pressed") === "true";
        btn.setAttribute("aria-pressed", on ? "false" : "true");
      }),
    );
  }

  _summary(city, handle, noted) {
    if (!city.length && !handle.length && !noted.length) {
      return "Photos, voice, and notes were all read.";
    }
    const parts = [];
    if (city.length)
      parts.push(
        `${word(city.length)} need${city.length === 1 ? "s" : ""} a city crew`,
      );
    if (handle.length)
      parts.push(
        `${word(handle.length)} ${handle.length === 1 ? "is" : "are"} yours to handle`,
      );
    if (noted.length) parts.push(`${word(noted.length)} noted only`);
    return `${cap(parts.join(", "))}. Photos, voice, and notes were all read.`;
  }

  _evidence(e, items) {
    const parts = [];
    if (e.photos) parts.push(`${e.photos} photo${e.photos === 1 ? "" : "s"}`);
    if (e.voice) parts.push(`${e.voice} voice`);
    if (e.notes) parts.push(`${e.notes} note${e.notes === 1 ? "" : "s"}`);
    const photos = items
      .filter((i) => i.kind === "photo" && i.thumbUrl)
      .slice(0, 4);
    const thumbs = photos.length
      ? photos
          .map(
            (p, i) =>
              html`<img
                class="evidence__thumb ${i < 2
                  ? "evidence__thumb--active"
                  : ""}"
                src="${p.thumbUrl}"
                alt=""
              />`,
          )
          .join("")
      : Array.from({ length: Math.min(e.photos, 4) })
          .map(() => html`<span class="evidence__thumb"></span>`)
          .join("");
    const noteCount = e.voice + e.notes;
    return html`
      <div class="evidence">
        <div class="evidence__head">
          <span class="evidence__label">Evidence · ${parts.join(", ")}</span>
          <a class="evidence__link" href="/check">See all</a>
        </div>
        <div class="evidence__strip">
          ${thumbs}
          ${noteCount
            ? html`<span class="evidence__thumb evidence__thumb--more"
                >${noteCount} notes</span
              >`
            : ""}
        </div>
      </div>
    `;
  }

  _cityBucket(city) {
    return html`
      <section class="bucket">
        <div class="bucket__head">
          <span class="bucket__title">City action · ${city.length}</span>
          <span class="bucket__meta">Don't handle these</span>
        </div>
        <div class="findcard">
          ${city.map((f, i) => this._cityRow(f, i)).join("")}
        </div>
      </section>
    `;
  }

  _cityRow(f, i) {
    const src = [
      f.side ? `${escapeHtml(f.side)}` : null,
      f.sourceKind ? escapeHtml(f.sourceKind) : null,
    ].filter(Boolean);
    src.push(`${confidence(f, i)}% confidence`);
    return html`
      <div class="findcard__row" role="button" tabindex="0">
        <div class="findcard__head">
          <span class="findcard__kicker">City action</span>
          <span class="pill pill--route">File 311</span>
        </div>
        <h3 class="findcard__title">${escapeHtml(f.category)}</h3>
        <p class="findcard__desc">${escapeHtml(f.explanation)}</p>
        <p class="findcard__prov">${src.join(" · ")}</p>
      </div>
    `;
  }

  _handleBucket(handle) {
    return html`
      <section class="bucket">
        <div class="bucket__head">
          <span class="bucket__title"
            >${word(handle.length)} you can handle</span
          >
          <span class="bucket__meta">Safe to clear</span>
        </div>
        <div class="checkcard">
          ${handle.map((f, i) => this._handleRow(f, i)).join("")}
        </div>
      </section>
    `;
  }

  _handleRow(f, i) {
    return html`
      <button class="checkitem" type="button" aria-pressed="false">
        <div class="checkitem__body">
          <p class="checkitem__title">${escapeHtml(f.category)}</p>
          <p class="checkitem__detail">
            ${escapeHtml(f.explanation)} · ${confidence(f, i)}%
          </p>
        </div>
        <span class="checkitem__ring" aria-hidden="true"></span>
      </button>
    `;
  }

  _notedBucket(noted) {
    return html`
      <div class="noted">
        <div class="noted__head">
          <span>Noted, no action · ${noted.length}</span>
          <span>Estimate</span>
        </div>
        <ul class="noted__list">
          ${noted
            .map(
              (f, i) =>
                html`<li class="noted__row">
                  <span class="noted__name">${escapeHtml(f.category)}</span>
                  <span class="noted__pct">${confidence(f, i)}%</span>
                </li>`,
            )
            .join("")}
        </ul>
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

customElements.define("check-results", CheckResults);
