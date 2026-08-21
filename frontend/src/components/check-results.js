// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  check-results — 5e (design port, screen 16). What the just-submitted check
  produced, presented as the SAME worklist the home hub shows, so the two screens
  never disagree on where an item belongs:
    - Escalate to the city  (task.type === "city_escalation")  -> File 311
    - Site actions          (task.type === "onsite")            -> handle on site
  The buckets are the backend's real TASK# items (listTasks), grouped by the
  authoritative `type` the guidance system stamps at task creation. We do NOT
  re-derive city-vs-handle from findings/category names here — that join drifted
  (analyzer category vs canonical guidance category) and mis-bucketed real city
  items. today-view.js is the reference implementation for this grouping.

  NOTE: the 311 ticket lifecycle isn't modeled yet (post-MVP). The bottom actions
  really close the backend TASK# items (completeTask) — same mutation the home
  worklist uses — so handled items don't reappear on the home hub; "File 311"
  just records the external filing (311_filed_external) without a ticket number.

  Reads the just-submitted check from the session (for its id + evidence photos);
  falls back to the most recent persisted check so the home "View" link still
  lands somewhere real (no evidence strip on that path — photos aren't inlined in
  the read model).
*/
import { html, escapeHtml } from "../lib/html.js";
import { getSite } from "../db.js";
import { listChecks, listTasks, completeTask } from "../services/api.js";
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

class CheckResults extends HTMLElement {
  async connectedCallback() {
    this._site = await getSite();
    this._siteId = this._site.siteId || this._site.id;

    const session = getCurrentCheck();
    let checkId, submittedAt, evidence, items;
    let tasks = [];
    try {
      if (session && session.status === "submitted") {
        checkId = session.id;
        submittedAt = session.submittedAt;
        items = allItems();
        evidence = {
          photos: items.filter((i) => i.kind === "photo").length,
          voice: items.filter((i) => i.kind === "voice").length,
          notes: items.filter((i) => i.kind === "note").length,
        };
      } else {
        // No just-submitted session (e.g. a "View" link for the latest check):
        // read the newest completed check from the backend. Photos aren't inlined
        // in the read model, so there's no evidence strip on this path.
        const { checks } = await listChecks({ limit: 10 });
        const latestHeader = (checks || []).find(
          (c) => c.status === "completed",
        );
        if (!latestHeader) {
          navigate("/today");
          return;
        }
        checkId = latestHeader.checkId;
        submittedAt =
          latestHeader.completedAt || latestHeader.startedAt || null;
        items = [];
        evidence = null;
      }

      // The worklist for THIS check: the backend's open TASK# items, grouped by
      // the type it stamped (city_escalation vs onsite). Same source + grouping
      // as today-view, so the two screens agree by construction.
      const { tasks: all } = await listTasks({ status: "open" });
      tasks = (all || []).filter((t) => t.checkId === checkId);
    } catch (err) {
      console.error("failed to load check results", err);
      navigate("/today");
      return;
    }

    this._tasksById = new Map(tasks.map((t) => [t.taskId, t]));

    const city = tasks.filter((t) => t.type === "city_escalation");
    const onsite = tasks.filter((t) => t.type === "onsite");
    const total = tasks.length;
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
              Evening check${submittedAt ? ` · ${timeOf(submittedAt)}` : ""}
            </h1>
          </div>
          <span class="topbar__meta"
            >${itemCount ? `${itemCount} items` : ""}</span
          >
        </div>

        <div class="flow-hero">
          <p class="flow-hero__eyebrow">Analysis</p>
          <h2 class="flow-hero__headline">
            ${total} item${total === 1 ? "" : "s"} to do
          </h2>
          <p class="flow-hero__body">${this._summary(city, onsite)}</p>
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
        ${onsite.length ? this._onsiteBucket(onsite) : ""}

        <div class="flow-ctas">
          ${city.length
            ? html`<button class="btn-ink" id="file-311" type="button">
                File 1 ticket for all ${word(city.length)}
              </button>`
            : ""}
          ${onsite.length
            ? html`<button class="btn-outline" id="mark-handled" type="button">
                Mark my ${word(onsite.length)} handled &amp; close
              </button>`
            : ""}
          ${!city.length && !onsite.length
            ? html`<button class="btn-ink" id="done" type="button">
                Back to home
              </button>`
            : ""}
          <p class="flow-error" id="cta-error" role="alert" hidden></p>
        </div>
        <p class="flow-foot">Tap any item to dispute it.</p>
      </div>
    `;

    const finish = () => {
      clearCheck();
      navigate("/today");
    };
    // Leaving the screen without acting (back / all-clear "Back to home") just
    // drops the session — it closes no tasks.
    this.querySelector("#back").addEventListener("click", finish);
    this.querySelector("#done")?.addEventListener("click", finish);

    // The bulk CTAs really close the backend tasks (same completeTask the home
    // worklist uses) before returning home, so handled items don't reappear
    // there. City -> "311 filed externally"; onsite -> manual. On any failure we
    // keep the user on this screen with an inline error rather than navigating
    // away as if it worked.
    const err = this.querySelector("#cta-error");
    const bulkClose = async (btn, group, completionMethod) => {
      if (!group.length) {
        finish();
        return;
      }
      const buttons = this.querySelectorAll(".flow-ctas button");
      buttons.forEach((b) => (b.disabled = true));
      if (err) {
        err.hidden = true;
        err.textContent = "";
      }
      try {
        await Promise.all(
          group.map((t) => completeTask(t.taskId, { completionMethod })),
        );
        finish();
      } catch (e) {
        console.error("bulk task close failed", e);
        buttons.forEach((b) => (b.disabled = false));
        if (err) {
          err.hidden = false;
          err.textContent = "Couldn’t save that — please try again.";
        }
      }
    };
    this.querySelector("#file-311")?.addEventListener("click", (e) =>
      bulkClose(e.currentTarget, city, "311_filed_external"),
    );
    this.querySelector("#mark-handled")?.addEventListener("click", (e) =>
      bulkClose(e.currentTarget, onsite, "manual"),
    );
    // Tap an item to "dispute" — post-MVP; harmless no-op affordance for now.
    this.querySelectorAll(".findcard__row").forEach((row) =>
      row.addEventListener("click", () => {}),
    );
    // "Site actions" items tick off in place.
    this.querySelectorAll(".checkitem").forEach((btn) =>
      btn.addEventListener("click", () => {
        const on = btn.getAttribute("aria-pressed") === "true";
        btn.setAttribute("aria-pressed", on ? "false" : "true");
      }),
    );
  }

  _summary(city, onsite) {
    if (!city.length && !onsite.length) {
      return "Nothing needs action from this walk. Photos, voice, and notes were all read.";
    }
    const parts = [];
    if (city.length)
      parts.push(
        `${word(city.length)} need${city.length === 1 ? "s" : ""} a city crew`,
      );
    if (onsite.length)
      parts.push(
        `${word(onsite.length)} ${onsite.length === 1 ? "is" : "are"} yours to handle`,
      );
    return `${cap(parts.join(", "))}. Photos, voice, and notes were all read.`;
  }

  _evidence(e, items) {
    const parts = [];
    if (e.photos) parts.push(`${e.photos} photo${e.photos === 1 ? "" : "s"}`);
    if (e.voice) parts.push(`${e.voice} voice`);
    if (e.notes) parts.push(`${e.notes} note${e.notes === 1 ? "" : "s"}`);
    const photos = items
      .filter((i) => i.kind === "photo" && i.dataUrl)
      .slice(0, 4);
    const thumbs = photos.length
      ? photos
          .map(
            (p, i) =>
              html`<img
                class="evidence__thumb ${i < 2
                  ? "evidence__thumb--active"
                  : ""}"
                src="${p.dataUrl}"
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
          <span class="bucket__title"
            >Escalate to the city · ${city.length}</span
          >
          <span class="bucket__meta">Don't handle these</span>
        </div>
        <div class="findcard">
          ${city.map((t) => this._cityRow(t)).join("")}
        </div>
      </section>
    `;
  }

  _cityRow(t) {
    const title = t.label || t.category || "Finding";
    const detail = t.guidance || t.category || "";
    return html`
      <div class="findcard__row" role="button" tabindex="0">
        <div class="findcard__head">
          <span class="findcard__kicker">City action</span>
          <span class="pill pill--route">File 311</span>
        </div>
        <h3 class="findcard__title">${escapeHtml(title)}</h3>
        ${detail
          ? html`<p class="findcard__desc">${escapeHtml(detail)}</p>`
          : ""}
      </div>
    `;
  }

  _onsiteBucket(onsite) {
    return html`
      <section class="bucket">
        <div class="bucket__head">
          <span class="bucket__title">Site actions · ${onsite.length}</span>
          <span class="bucket__meta">Safe to clear</span>
        </div>
        <div class="checkcard">
          ${onsite.map((t) => this._onsiteRow(t)).join("")}
        </div>
      </section>
    `;
  }

  _onsiteRow(t) {
    const title = t.label || t.category || "Finding";
    const detail = t.guidance || t.category || "";
    return html`
      <button class="checkitem" type="button" aria-pressed="false">
        <div class="checkitem__body">
          <p class="checkitem__title">${escapeHtml(title)}</p>
          ${detail
            ? html`<p class="checkitem__detail">${escapeHtml(detail)}</p>`
            : ""}
        </div>
        <span class="checkitem__ring" aria-hidden="true"></span>
      </button>
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
