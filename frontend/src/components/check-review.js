// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  check-review — 5d (design port, screen 15). The per-side coverage ledger, then
  submit. No second capture step: everything was captured per side; this shows how
  each side got covered and files the check. On submit we run the (mock) analyzer
  over every item, derive findings, persist the check, and hand off to 5e.
*/
import { html, escapeHtml } from "../lib/html.js";
import { getSite } from "../db.js";
import { navigate } from "../router.js";
import { submitCheck } from "../services/submit-check.js";
import {
  SIDES,
  getCurrentCheck,
  isSideCovered,
  allItems,
} from "../state/check-session.js";

const NUM_WORD = ["zero", "one", "two", "three", "four"];

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// Per-side one-line summary from real photo counts.
function summarize(sideState) {
  if (sideState.skipped) return "Skipped";
  if (!sideState.items.length) return "Not covered yet";
  return plural(sideState.items.length, "photo");
}

// A representative thumbnail for a side: its first photo, else a placeholder glyph.
function sideThumb(sideState) {
  const photo = sideState.items.find((i) => i.dataUrl);
  if (photo)
    return html`<img class="rowcard__thumb" src="${photo.dataUrl}" alt="" />`;
  return html`<span class="rowcard__thumb">▦</span>`;
}

class CheckReview extends HTMLElement {
  async connectedCallback() {
    this._site = await getSite();
    const check = getCurrentCheck();
    if (!check) {
      navigate("/today");
      return;
    }

    const covered = SIDES.filter((s) => isSideCovered(s)).length;
    const total = SIDES.length;
    const items = allItems();
    const itemCount = items.length;
    const ready = covered === total && itemCount > 0;

    const counts = { photo: 0, voice: 0, note: 0 };
    for (const it of items) counts[it.kind]++;
    const evidenceParts = [];
    if (counts.photo) evidenceParts.push(plural(counts.photo, "photo"));
    if (counts.voice) evidenceParts.push(plural(counts.voice, "voice note"));
    if (counts.note) evidenceParts.push(plural(counts.note, "written note"));

    this.innerHTML = html`
      <div class="flow view-review">
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
            <h1 class="topbar__title">Review</h1>
          </div>
          <span class="topbar__meta">${covered} of ${total} sides</span>
        </div>

        <div class="flow-hero">
          <p class="flow-hero__eyebrow">
            ${ready ? "Perimeter walked" : "Almost there"}
          </p>
          <h2 class="flow-hero__headline">
            ${ready
              ? `All ${NUM_WORD[total]} sides covered`
              : "Finish the walk"}
          </h2>
          <p class="flow-hero__body">
            ${ready
              ? html`${evidenceParts.join(", ")}. All of it feeds the analysis.`
              : html`Cover every side (or mark it “can’t cover”) before
                submitting.`}
          </p>
        </div>

        <div class="rowcard">
          ${SIDES.map((side) => this._sideRow(side, check.sides[side])).join(
            "",
          )}
        </div>

        <div class="infostrip">
          <span
            >${plural(itemCount, "item")} uploaded ·
            ${ready ? "analysis ready" : "keep going"}</span
          >
          <a class="infostrip__link" id="review-all" href="/check"
            >Review all</a
          >
        </div>

        <button
          class="btn-ink"
          id="submit"
          type="button"
          ${ready ? "" : "disabled"}
        >
          Submit check &amp; see results
        </button>
        <p class="flow-foot">Your report is filed either way.</p>
      </div>
    `;

    this.querySelector("#submit").addEventListener("click", () =>
      this._submit(),
    );
    this.querySelector("#back").addEventListener("click", () =>
      navigate("/check"),
    );
    this.querySelector(".rowcard").addEventListener("click", (e) => {
      if (e.target.closest("[data-add]")) {
        e.preventDefault();
        navigate("/check");
      }
    });
  }

  _sideRow(side, state) {
    return html`
      <div class="rowcard__row">
        ${sideThumb(state)}
        <div class="rowcard__body">
          <p class="rowcard__title">${escapeHtml(side)}</p>
          <p class="rowcard__detail">${escapeHtml(summarize(state))}</p>
        </div>
        <button
          class="rowcard__action"
          type="button"
          data-add="${escapeHtml(side)}"
        >
          Add
        </button>
      </div>
    `;
  }

  async _submit() {
    const btn = this.querySelector("#submit");
    const label = btn.textContent;
    btn.setAttribute("disabled", "");
    btn.textContent = "Filing…";
    this._clearError();
    try {
      await submitCheck();
      navigate("/today");
    } catch (err) {
      // Online-only: on any backend/network failure surface an error and let the
      // user retry (no local queue — offline is post-MVP).
      console.error("submitCheck failed", err);
      btn.removeAttribute("disabled");
      btn.textContent = label;
      this._showError(
        "Couldn’t file this check — the server didn’t respond. Check your connection and try again.",
      );
    }
  }

  _showError(msg) {
    let el = this.querySelector(".flow-error");
    if (!el) {
      el = document.createElement("p");
      el.className = "flow-error";
      el.setAttribute("role", "alert");
      this.querySelector("#submit").insertAdjacentElement("beforebegin", el);
    }
    el.textContent = msg;
  }

  _clearError() {
    this.querySelector(".flow-error")?.remove();
  }
}
customElements.define("check-review", CheckReview);
