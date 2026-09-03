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
  evaluateAssessment with every clarification the reviewer made, keyed by category
  (not_present / better / worse / other). The backend records all of them for
  false-positive analysis, but only "I don't see this problem" (not_present)
  suppresses task minting for that condition; better/worse/other are recorded as
  feedback yet still evaluate into tasks. Disputes are actionable only on the live
  post-submit path (the session carries the assessment envelope); the history/"View"
  path is read-only. If evaluate fails we stay on the screen (surfacing an error)
  rather than silently dropping task minting.

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
import { loadSubmitted, allItems, clearCheck } from "../state/check-session.js";
import { mark } from "../services/instrument.js";

// Dispute options offered in the modal. `status` is the phrase shown on the card
// after the user picks it ("You marked this as <status>").
const DECISIONS = [
  {
    key: "not_present",
    label: "I don't see this problem",
    status: "not present",
  },
  {
    key: "better",
    label: "It's better than described",
    status: "better than described",
  },
  {
    key: "worse",
    label: "It's worse than described",
    status: "worse than described",
  },
  { key: "other", label: "Something else", status: "something else" },
];

class CheckResults extends HTMLElement {
  // conditionId -> decision key. Local, ephemeral (lost on navigation) — not persisted.
  _decisions = new Map();

  async connectedCallback() {
    // loadSubmitted rehydrates a just-submitted session from IndexedDB after a
    // reload, so the disputable path (assessment envelope + findings + photos)
    // survives refresh instead of dropping to the read-only history path.
    const session = await loadSubmitted();
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

    // One card per backend condition (one per category), so a dispute targets
    // exactly that condition via its stable conditionId — never a sibling that
    // happens to share a category.
    const conditions = this._reviewConditions(findings);

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
        ${conditions.length
          ? this._assessment(summary, conditions, canDispute)
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
          <h2 class="visually-hidden">
            What's not right about this condition?
          </h2>
          <ul class="sheet__opts">
            ${DECISIONS.map(
              (d) =>
                html`<li>
                  <wa-button
                    class="sheet__opt"
                    type="button"
                    appearance="outlined"
                    data-key="${d.key}"
                  >
                    ${escapeHtml(d.label)}
                  </wa-button>
                </li>`,
            ).join("")}
          </ul>
          <wa-button
            class="sheet__cancel"
            type="button"
            id="dispute-cancel"
            appearance="plain"
          >
            Cancel
          </wa-button>
        </div>
      </dialog>
    `;

    // Journey endpoint: the assessment is now on screen for the user to review.
    // On the live post-submit path (no reload) the run epoch is still the submit
    // tap, so this line's `+Nms` is the full submit→review latency.
    mark("review:rendered", {
      checkId,
      conditions: conditions.length,
      source: canDispute ? "post-submit" : "history",
    });

    this._dialog = this.querySelector("#dispute");

    // Leaving the screen finalizes the review: on the live path, mint tasks now
    // (evaluateAssessment), sending every clarification the reviewer made. Only
    // "I don't see this problem" excludes a category from task minting.
    // One-shot so Close+Continue can't double-fire; on failure we stay put so task
    // minting isn't silently lost.
    let finishing = false;
    const finish = async () => {
      if (finishing) return;
      finishing = true;
      if (this._assessmentData) {
        // Every clarification the reviewer made, keyed by the condition's stable id:
        // { "<conditionId>": "not_present" | "better" | "worse" | "other" }. The
        // backend records all of them; only "not_present" suppresses task minting for
        // that condition. Keying by conditionId (not category) means disputing one
        // condition never affects another that happens to share a category.
        const dispositions = {};
        for (const [cid, key] of this._decisions.entries()) {
          if (cid) dispositions[cid] = key;
        }
        try {
          await evaluateAssessment(this._assessmentData, dispositions);
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
      if (flag) return this._openModal(flag.dataset.cid);

      const undo = t.closest(".issue__undo");
      if (undo) return this._setDecision(undo.dataset.cid, null);

      const opt = t.closest(".sheet__opt");
      if (opt) {
        this._setDecision(this._dialog.dataset.cid, opt.dataset.key);
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
      <ul class="thumbstrip" aria-label="Photos from this check">
        ${photos
          .map(
            (p) =>
              html`<li class="thumbstrip__item">
                <img
                  class="thumbstrip__thumb"
                  src="${p.dataUrl}"
                  alt="${escapeHtml(
                    p.side
                      ? `Photo of the ${p.side} side`
                      : "Perimeter check photo",
                  )}"
                />
              </li>`,
          )
          .join("")}
      </ul>
    `;
  }

  // Build the per-condition review list — one entry per backend condition (which is
  // one per category). Each card then maps 1:1 to a condition, so a dispute targets
  // exactly that condition via its stable conditionId. The disputable (live) path is
  // driven by the assessment envelope's conditions; each is enriched with the sides
  // it was seen on (from the per-artifact findings). The read-only history path has
  // no envelope, so findings are grouped by category (no conditionId — those cards
  // can't be disputed anyway).
  _reviewConditions(findings) {
    const sidesFor = (category) => [
      ...new Set(
        findings
          .filter((f) => f.category === category && f.side)
          .map((f) => f.side),
      ),
    ];
    const envelope = this._assessmentData?.conditions;
    if (Array.isArray(envelope) && envelope.length) {
      return envelope.map((c) => ({
        conditionId: c.conditionId || null,
        category: c.category || "Condition",
        explanation:
          c.description ||
          findings.find((f) => f.category === c.category)?.explanation ||
          "",
        sides: sidesFor(c.category),
      }));
    }
    const byCategory = new Map();
    for (const f of findings) {
      if (byCategory.has(f.category)) continue;
      byCategory.set(f.category, {
        conditionId: null,
        category: f.category || "Condition",
        explanation: f.explanation || "",
        sides: sidesFor(f.category),
      });
    }
    return [...byCategory.values()];
  }

  // The grey assessment panel: sparkle + overall summary, then one white issue
  // card per identified condition.
  _assessment(summary, conditions, canDispute) {
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
          ${conditions.map((c) => this._issue(c, canDispute)).join("")}
        </div>
      </section>
    `;
  }

  _issue(c, canDispute) {
    const title = c.category || "Condition";
    const cid = c.conditionId || "";
    return html`
      <div class="issue" data-cid="${escapeHtml(cid)}">
        <h3 class="issue__title">${escapeHtml(title)}</h3>
        ${c.sides && c.sides.length
          ? html`<p class="issue__sides">${escapeHtml(c.sides.join(" · "))}</p>`
          : ""}
        ${c.explanation
          ? html`<p class="issue__desc">${escapeHtml(c.explanation)}</p>`
          : ""}
        <div class="issue__foot">
          ${this._cardFoot(c.conditionId, canDispute)}
        </div>
      </div>
    `;
  }

  // The card footer flips between the dispute trigger and the "marked" status.
  // Read-only (history) path, or a condition without a stable id: no trigger.
  _cardFoot(cid, canDispute) {
    if (!canDispute || !cid) return "";
    const key = this._decisions.get(cid);
    if (!key) {
      return html`<button
        class="issue__flag"
        type="button"
        data-cid="${escapeHtml(cid)}"
      >
        Something not right?
      </button>`;
    }
    const d = DECISIONS.find((x) => x.key === key);
    return html`<p class="issue__status">
      You marked this as ${escapeHtml(d.status)} ·
      <button class="issue__undo" type="button" data-cid="${escapeHtml(cid)}">
        Undo
      </button>
    </p>`;
  }

  // Apply (key) or clear (null) a condition's dispute decision and re-render its foot.
  _setDecision(cid, key) {
    if (!cid) return;
    if (key) this._decisions.set(cid, key);
    else this._decisions.delete(cid);
    const card = this.querySelector(`.issue[data-cid="${cid}"]`);
    if (!card) return;
    card.classList.toggle("issue--marked", this._decisions.has(cid));
    // Reachable only from the flag/undo controls, which exist on the live path.
    card.querySelector(".issue__foot").innerHTML = this._cardFoot(cid, true);
  }

  _openModal(cid) {
    if (!cid) return;
    this._dialog.dataset.cid = cid;
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
