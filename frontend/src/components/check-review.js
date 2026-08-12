// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  check-review — 5d. The per-side coverage ledger, then submit. No second capture
  step: everything was captured per side, this just shows how each side got covered
  and files the check. On submit we run the (mock) analyzer over every item, derive
  findings, persist the check, and hand off to 5e.
*/
import { html, escapeHtml } from "../lib/html.js";
import { getSite, addCheck } from "../db.js";
import { navigate } from "../router.js";
import { analyzeCheck } from "../services/analyzer.js";
import { scorecardToFindings } from "../domain/findings.js";
import {
  SIDES,
  getCurrentCheck,
  isSideCovered,
  allItems,
  markSubmitted,
} from "../state/check-session.js";

function summarize(sideState) {
  if (!sideState.applicable) return "Not applicable";
  if (!sideState.items.length) return "Not covered yet";
  const counts = { photo: 0, voice: 0, note: 0 };
  for (const it of sideState.items) counts[it.kind]++;
  const parts = [];
  if (counts.photo)
    parts.push(`${counts.photo} photo${counts.photo === 1 ? "" : "s"}`);
  if (counts.voice) parts.push(`${counts.voice} voice`);
  if (counts.note)
    parts.push(`${counts.note} note${counts.note === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

class CheckReview extends HTMLElement {
  async connectedCallback() {
    this._site = await getSite();
    const check = getCurrentCheck();
    if (!check) {
      navigate("/today");
      return;
    }

    const covered = SIDES.filter(isSideCovered).length;
    const total = SIDES.length;
    const itemCount = allItems().length;
    const ready = covered === total && itemCount > 0;

    this.innerHTML = html`
      <div class="stack view-review">
        <header class="check-head">
          <h2>Review</h2>
          <p class="hint">
            ${covered} of ${total} sides · ${itemCount}
            item${itemCount === 1 ? "" : "s"}
          </p>
        </header>

        <section class="card">
          <h3>${ready ? "Perimeter walked" : "Finish the walk"}</h3>
          <p class="hint">
            ${ready
              ? "Every side is covered. All of it feeds the analysis."
              : 'Cover every side (or mark it "can\'t cover") before submitting.'}
          </p>
          <ul class="ledger">
            ${SIDES.map((side) => this._sideRow(side, check.sides[side])).join(
              "",
            )}
          </ul>
        </section>

        <wa-button
          id="submit"
          variant="neutral"
          appearance="accent"
          size="large"
          class="cta"
          ${ready ? "" : "disabled"}
        >
          Submit check &amp; see results
        </wa-button>
        <p class="hint center">Your report is filed either way.</p>
      </div>
    `;

    this.querySelector("#submit").addEventListener("click", () =>
      this._submit(),
    );
    this.querySelector(".ledger").addEventListener("click", (e) => {
      if (e.target.closest("[data-add]")) navigate("/check");
    });
  }

  _sideRow(side, state) {
    const covered = isSideCovered(state) || !state.applicable;
    return html`
      <li class="ledger__row">
        <wa-icon
          class="ledger__mark ${covered ? "is-ok" : ""}"
          name="${covered ? "circle-check" : "circle-plus"}"
          aria-hidden="true"
        ></wa-icon>
        <div class="ledger__body">
          <p class="ledger__side">${escapeHtml(side)}</p>
          <p class="hint">${escapeHtml(summarize(state))}</p>
        </div>
        <wa-button
          type="button"
          appearance="plain"
          size="small"
          data-add="${escapeHtml(side)}"
          >Add</wa-button
        >
      </li>
    `;
  }

  async _submit() {
    const btn = this.querySelector("#submit");
    btn.setAttribute("loading", "");
    btn.setAttribute("disabled", "");

    const items = allItems();
    const scorecard = await analyzeCheck(items);
    const findings = scorecardToFindings(scorecard, items);
    const check = markSubmitted(findings);

    // Persist a self-contained summary (see db.js) so 5b/history + streak can read it.
    await addCheck({
      id: check.id,
      siteId: check.siteId,
      window: check.window,
      startedAt: check.startedAt,
      submittedAt: check.submittedAt,
      status: "submitted",
      statusLabel: scorecard.status_label,
      totalScore: scorecard.total_score,
      sides: SIDES.map((s) => ({
        side: s,
        applicable: check.sides[s].applicable,
        itemCount: check.sides[s].items.length,
      })),
      findings,
      synced: false,
    });

    navigate("/results");
  }
}
customElements.define("check-review", CheckReview);
