// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  check-results — "Review conditions" (screen 16), shown right after a perimeter
  check is submitted. This screen presents the FULL list of conditions the AI
  identified for the run, so the user can review (and dispute) them before
  continuing. It is ANALYSIS-sourced, not task-sourced:
    - the overall summary + grade come from the CHECK# header (check.summary /
      check.grade), which synthesize-check.js already rolls up as the worst
      artifact's assessment across the run's sides.
    - the issue cards are the per-artifact ANALYSIS# concerns (analysesToFindings),
      one card per identified condition (rating >= 1), titled by the analyzer's
      own category with its explanation.

  Dispute ("Something not right?"): each card opens a modal offering four takes on
  the condition (not present / better / worse / something else). Choosing one marks
  the card (strikethrough + a "You marked this as ..." status with Undo).

  Task minting is DEFERRED to this screen: leaving it (Continue/Close) calls
  evaluateAssessment with the categories marked "I don't see this problem", so the
  backend records those conditions but never turns them into tasks (kept for
  false-positive analysis). The other three dispute takes are local UI only this
  pass (not sent). Disputes are actionable only on the live post-submit path (the
  session carries the assessment envelope); the history/"View" path is read-only.
  If evaluate fails we stay on the screen (surfacing an error) rather than silently
  dropping task minting.

  The task worklist (what the city handles vs. what the user handles) then lives
  on the home hub (today-view), which fetches those minted tasks after Continue.

  Data: resolve the checkId from the just-submitted session (also the source of the
  photo thumbnails, which aren't inlined in the read model), else fall back to the
  newest completed check so the home "View" link lands somewhere real (no thumbnails
  on that path). Then getCheck(checkId) -> adaptCheckDetail for summary + findings.
*/
import { html, escapeHtml } from "../lib/html.js";
import { listChecks, getCheck, evaluateAssessment } from "../services/api.js";
import { adaptCheckDetail } from "../domain/check-adapter.js";
import { navigate } from "../router.js";
import { getCurrentCheck, allItems, clearCheck } from "../state/check-session.js";

// Dispute options offered in the modal. `status` is the phrase shown on the card
// after the user picks it ("You marked this as <status>").
const DECISIONS = [
  { key: "not_present", label: "I don't see this problem", status: "not present" },
  { key: "better", label: "It's better than described", status: "better than described" },
  { key: "worse", label: "It's worse than described", status: "worse than described" },
  { key: "other", label: "Something else", status: "something else" },
];

class CheckResults extends HTMLElement {
  // idx -> decision key. Local, ephemeral (lost on navigation) — not persisted.
  _decisions = new Map();

  async connectedCallback() {
    const session = getCurrentCheck();
    let checkId;
    let photos = [];
    try {
      if (session && session.status === "submitted") {
        checkId = session.id;
        // Thumbnails come from the in-memory session — photos aren't inlined in
        // the backend read model, so they exist only on the just-submitted path.
        photos = allItems().filter((i) => i.kind === "photo" && i.dataUrl);
      } else {
        // No just-submitted session (e.g. the home "View" link): read the newest
        // completed check from the backend. No thumbnails on this path.
        const { checks } = await listChecks({ limit: 10 });
        const latest = (checks || []).find((c) => c.status === "completed");
        if (!latest) {
          navigate("/today");
          return;
        }
        checkId = latest.checkId;
      }

      const detail = await getCheck(checkId);
      this._check = adaptCheckDetail(detail);
    } catch (err) {
      console.error("failed to load check results", err);
      navigate("/today");
      return;
    }

    const findings = this._check.findings || [];
    const summary = this._check.summary;

    // Disputes are actionable only right after submit, when the session carries
    // the assessment envelope to (re)evaluate. On the history/"View" path there's
    // nothing to evaluate, so cards render read-only.
    const canDispute = !!(session && session.status === "submitted");
    this._assessmentData = canDispute ? session.assessment || null : null;

    this.innerHTML = html`
      <div class="flow view-results">
        <div class="topbar topbar--review">
          <div class="topbar__titles">
            <h1 class="topbar__title">Review conditions</h1>
            <p class="topbar__sub">
              AI reviewed your report. Review the conditions identified below
              before continuing.
            </p>
          </div>
          <button
            class="topbar__back"
            id="close"
            type="button"
            aria-label="Close"
          >
            <wa-icon name="xmark" aria-hidden="true"></wa-icon>
          </button>
        </div>

        ${photos.length ? this._thumbs(photos) : ""}

        ${findings.length
          ? this._assessment(summary, findings, canDispute)
          : this._allClear(summary)}

        <div class="flow-ctas">
          <p class="flow-error" id="results-error" role="alert" hidden>
            Couldn't save your review. Check your connection and try again.
          </p>
          <button class="btn-ink" id="continue" type="button">Continue</button>
        </div>
      </div>

      <dialog class="sheet" id="dispute" aria-label="Something not right?">
        <div class="sheet__panel">
          <h2 class="visually-hidden">What's not right about this condition?</h2>
          <ul class="sheet__opts">
            ${DECISIONS.map(
              (d) =>
                html`<li>
                  <button class="sheet__opt" type="button" data-key="${d.key}">
                    ${escapeHtml(d.label)}
                  </button>
                </li>`,
            ).join("")}
          </ul>
          <button class="sheet__cancel" type="button" id="dispute-cancel">
            Cancel
          </button>
        </div>
      </dialog>
    `;

    this._dialog = this.querySelector("#dispute");

    // Leaving the screen finalizes the review: on the live path, mint tasks now
    // (evaluateAssessment), excluding categories marked "I don't see this problem".
    // One-shot so Close+Continue can't double-fire; on failure we stay put so task
    // minting isn't silently lost.
    let finishing = false;
    const finish = async () => {
      if (finishing) return;
      finishing = true;
      if (this._assessmentData) {
        const disputed = [
          ...new Set(
            [...this._decisions.entries()]
              .filter(([, key]) => key === "not_present")
              .map(([i]) => findings[i] && findings[i].category)
              .filter(Boolean),
          ),
        ];
        try {
          await evaluateAssessment(this._assessmentData, disputed);
        } catch (err) {
          console.error("failed to finalize review", err);
          finishing = false;
          const errEl = this.querySelector("#results-error");
          if (errEl) errEl.hidden = false;
          return;
        }
      }
      clearCheck();
      navigate("/today");
    };

    // One delegated handler for the whole screen (survives the card footer
    // innerHTML swaps that Undo/mark performs).
    this.addEventListener("click", (e) => {
      const t = e.target;
      if (t.closest("#close") || t.closest("#continue")) return finish();

      const flag = t.closest(".issue__flag");
      if (flag) return this._openModal(Number(flag.dataset.idx));

      const undo = t.closest(".issue__undo");
      if (undo) return this._setDecision(Number(undo.dataset.idx), null);

      const opt = t.closest(".sheet__opt");
      if (opt) {
        this._setDecision(Number(this._dialog.dataset.idx), opt.dataset.key);
        this._dialog.close();
        return;
      }

      if (t.closest("#dispute-cancel")) return this._dialog.close();
      // Click on the backdrop (target is the <dialog> itself) dismisses it.
      if (t === this._dialog) return this._dialog.close();
    });
  }

  // Horizontal, display-only strip of the run's photos (no controls this pass).
  _thumbs(photos) {
    return html`
      <div class="thumbstrip" role="list" aria-label="Photos from this check">
        ${photos
          .map(
            (p) =>
              html`<img
                class="thumbstrip__thumb"
                role="listitem"
                src="${p.dataUrl}"
                alt=""
              />`,
          )
          .join("")}
      </div>
    `;
  }

  // The grey assessment panel: sparkle + overall summary, then one white issue
  // card per identified condition.
  _assessment(summary, findings, canDispute) {
    return html`
      <section class="assess">
        <div class="assess__head">
          <wa-icon
            class="assess__spark"
            name="sparkles"
            aria-hidden="true"
          ></wa-icon>
          <p class="assess__summary">
            ${summary ? escapeHtml(summary) : "summary missing"}
          </p>
          <p class="assess__sub">Review anything that doesn't look right.</p>
        </div>
        <div class="assess__list">
          ${findings.map((f, i) => this._issue(f, i, canDispute)).join("")}
        </div>
      </section>
    `;
  }

  _issue(f, i, canDispute) {
    const title = f.category || "Condition";
    return html`
      <div class="issue" data-idx="${i}">
        <h3 class="issue__title">${escapeHtml(title)}</h3>
        ${f.explanation
          ? html`<p class="issue__desc">${escapeHtml(f.explanation)}</p>`
          : ""}
        <div class="issue__foot">${this._cardFoot(i, canDispute)}</div>
      </div>
    `;
  }

  // The card footer flips between the dispute trigger and the "marked" status.
  // Read-only (history) path: no trigger at all.
  _cardFoot(i, canDispute) {
    if (!canDispute) return "";
    const key = this._decisions.get(i);
    if (!key) {
      return html`<button class="issue__flag" type="button" data-idx="${i}">
        Something not right?
      </button>`;
    }
    const d = DECISIONS.find((x) => x.key === key);
    return html`<p class="issue__status">
      You marked this as ${escapeHtml(d.status)} ·
      <button class="issue__undo" type="button" data-idx="${i}">Undo</button>
    </p>`;
  }

  // Apply (key) or clear (null) a card's dispute decision and re-render its foot.
  _setDecision(i, key) {
    if (key) this._decisions.set(i, key);
    else this._decisions.delete(i);
    const card = this.querySelector(`.issue[data-idx="${i}"]`);
    if (!card) return;
    card.classList.toggle("issue--marked", this._decisions.has(i));
    // Reachable only from the flag/undo controls, which exist on the live path.
    card.querySelector(".issue__foot").innerHTML = this._cardFoot(i, true);
  }

  _openModal(i) {
    this._dialog.dataset.idx = String(i);
    this._dialog.showModal();
  }

  // Zero findings: a single reassuring card in place of the issue list.
  _allClear(summary) {
    return html`
      <section class="assess">
        <div class="assess__head">
          <wa-icon
            class="assess__spark"
            name="sparkles"
            aria-hidden="true"
          ></wa-icon>
          <p class="assess__summary">
            ${summary ? escapeHtml(summary) : "summary missing"}
          </p>
        </div>
        <div class="rowcard">
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
        </div>
      </section>
    `;
  }
}

customElements.define("check-results", CheckResults);
