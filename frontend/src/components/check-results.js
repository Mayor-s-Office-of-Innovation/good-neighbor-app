// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  check-results — 5e. Itemized findings from the submitted check, GROUPED BY SEVERITY
  (Hazard → Moderate & severe → Minor). No triage buckets, no recommended-action CTAs,
  no confidence % — all deferred (docs/take5-plan.md). Severity is carried by the group
  heading + the severity word, never color alone.

  Reads the just-submitted check from the session; falls back to the most recent
  persisted check so the home-screen "View" link still lands somewhere real.
*/
import { html, escapeHtml } from "../lib/html.js";
import { getSite, getChecksForSite } from "../db.js";
import { navigate } from "../router.js";
import { groupBySeverity } from "../domain/findings.js";
import {
  getCurrentCheck,
  allItems,
  clearCheck,
} from "../state/check-session.js";

// Neutral system: severity is carried by the word + grouping. Color is reserved —
// red only reinforces an actual hazard; everything else stays greyscale (neutral).

class CheckResults extends HTMLElement {
  async connectedCallback() {
    this._site = await getSite();

    const session = getCurrentCheck();
    let findings;
    let evidence; // { photos, notes, voice } | null
    if (session && session.status === "submitted") {
      findings = session.findings || [];
      const items = allItems();
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
      evidence = null;
    }

    const groups = groupBySeverity(findings);
    const total = findings.length;
    const hasHazard = groups.some((g) => g.key === "hazard");

    this.innerHTML = html`
      <div class="stack view-results">
        <header class="check-head">
          <h2>Results</h2>
          <p class="hint">
            ${total}
            finding${total === 1 ? "" : "s"}${evidence
              ? " · " + this._evidenceLabel(evidence)
              : ""}
          </p>
        </header>

        ${hasHazard
          ? html`<wa-callout variant="danger">
              <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
              A hazard was found. Don't handle it — open a 311 ticket so the
              city responds.
            </wa-callout>`
          : ""}
        ${total === 0
          ? html`<section class="card">
              <p class="empty">All clear — no conditions found. Nice work.</p>
            </section>`
          : groups.map((g) => this._group(g)).join("")}

        <wa-button
          id="done"
          variant="neutral"
          appearance="accent"
          size="large"
          class="cta"
          >Back to home</wa-button
        >
      </div>
    `;

    this.querySelector("#done").addEventListener("click", () => {
      clearCheck();
      navigate("/today");
    });
  }

  _evidenceLabel(e) {
    const parts = [];
    if (e.photos) parts.push(`${e.photos} photo${e.photos === 1 ? "" : "s"}`);
    if (e.voice) parts.push(`${e.voice} voice`);
    if (e.notes) parts.push(`${e.notes} note${e.notes === 1 ? "" : "s"}`);
    return parts.join(", ");
  }

  _group(g) {
    return html`
      <section class="card finding-group">
        <div class="finding-group__head">
          <h3>${escapeHtml(g.title)} · ${g.items.length}</h3>
          <p class="hint">${escapeHtml(g.note)}</p>
        </div>
        <ul class="findings">
          ${g.items.map((f) => this._finding(f)).join("")}
        </ul>
      </section>
    `;
  }

  _finding(f) {
    const source = [
      f.side ? `${escapeHtml(f.side)} side` : null,
      f.sourceKind ? escapeHtml(f.sourceKind) : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return html`
      <li class="finding">
        <div class="finding__head">
          <p class="finding__title">${escapeHtml(f.category)}</p>
          <wa-badge
            variant="${f.hazard ? "danger" : "neutral"}"
            appearance="outlined"
          >
            ${escapeHtml(f.hazard ? "Hazard" : f.severity)}
          </wa-badge>
        </div>
        <p class="hint">${escapeHtml(f.explanation)}</p>
        ${source ? html`<p class="finding__source">${source}</p>` : ""}
      </li>
    `;
  }
}
customElements.define("check-results", CheckResults);
