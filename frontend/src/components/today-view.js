/*
  today-view — the home hub (the screen with the "Perimeter check" button).

  One always-on screen (no due/up-to-date fork), driven by real data. When we have
  the data, it shows two sections:
    1. Overall summary of the last perimeter check — the analyzer's own one-line
       summary (CHECK# header `summary`, synthesized at complete-time), with the
       LAST LOG timestamp beneath it. Falls back to a derived headline for checks
       completed before the summary field existed; omitted entirely if there is no
       submitted check yet.
    2. Open tasks — the site's real TASK# worklist, in boxed groups: SITE ACTIONS
       (onsite) then ESCALATE TO THE CITY (city). Cards carry the task's own action
       buttons, wired to the real complete / cannot-do endpoints.

  311 has no integration yet: filing a ticket happens outside the app, so the
  escalation card's button reads "Filed 311 ticket" and simply closes the task for
  the record (no 311 API call, no ticket number). Markup is inline via the `html`
  tag; split into a .templates.js file if it grows (see CLAUDE.md convention).
*/
import { html, escapeHtml } from "../lib/html.js";
import { getSite, getDraft } from "../db.js";
import {
  listChecks,
  listTasks,
  completeTask,
  cannotDoTask,
} from "../services/api.js";
import {
  adaptCheckHeader,
  cityCategoriesByCheck,
} from "../domain/check-adapter.js";
import { startCheck, clearCheck } from "../state/check-session.js";
import { navigate } from "../router.js";

class TodayView extends HTMLElement {
  async connectedCallback() {
    this._site = await getSite();
    this._siteId =
      this._site.siteId || this._site.providerSiteId || this._site.id;

    // Checks + the open worklist are read from the backend on load (AP6/AP10) —
    // newest first, adapted to the UI record shape. Online-only: on failure show
    // an error, not a crash.
    let submitted, tasks;
    try {
      const [{ checks }, tasksResult] = await Promise.all([
        listChecks({ limit: 30 }),
        listTasks({ status: "open", limit: 50 }),
      ]);
      tasks = tasksResult.tasks || [];
      const cityByCheck = cityCategoriesByCheck(tasks);
      submitted = (checks || [])
        .map((h) => adaptCheckHeader(h, cityByCheck.get(h.checkId)))
        .filter((c) => c.status === "submitted")
        .sort((a, b) =>
          (b.submittedAt || "").localeCompare(a.submittedAt || ""),
        );
    } catch (err) {
      console.error("listChecks/listTasks failed", err);
      this._renderError();
      return;
    }

    const last = submitted[0];
    // A resumable in-progress walk (Cancel from /check keeps it) turns the CTA
    // into Resume + "Start over".
    const hasDraft = !!(await getDraft());

    // Index tasks by id so card action handlers can read the task (e.g. its
    // allowlisted cannot-do reasons) at click time.
    this._tasksById = new Map(tasks.map((t) => [t.taskId, t]));

    this.innerHTML = this._render({ last, tasks, hasDraft });

    const start = this.querySelector("#start-check");
    if (start) {
      start.addEventListener("click", () => {
        // Resume just re-opens /check (the draft hydrates there); a fresh start
        // seeds a new in-progress check.
        if (!hasDraft) startCheck(this._siteId);
        navigate("/check");
      });
    }
    const over = this.querySelector("#start-over");
    if (over) {
      over.addEventListener("click", () => {
        clearCheck(); // discard the draft
        startCheck(this._siteId);
        navigate("/check");
      });
    }

    this._wireCards();
  }

  _render({ last, tasks, hasDraft }) {
    const onsite = tasks.filter((t) => t.type === "onsite");
    const city = tasks.filter((t) => t.type === "city_escalation");

    return html`
      <div class="home">
        <div class="screen" role="group" aria-label="Today">
          ${this._siteHeader()}
          <div class="screen__sec home-lead">
            ${this._summaryBlock(last)}
            <div class="home-cta">
              <button
                id="start-check"
                class="btn-ink btn-ink--block"
                type="button"
              >
                <wa-icon name="camera" aria-hidden="true"></wa-icon>
                ${hasDraft ? "Resume perimeter check" : "Perimeter check"}
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

        ${tasks.length
          ? html`
              <div class="worklist">
                <p class="worklist__counter">To do · ${tasks.length}</p>
                ${this._group("Site actions", onsite, "")}
                ${this._group(
                  "Escalate to the city",
                  city,
                  "worklist__group--city",
                )}
              </div>
            `
          : html`<p class="empty" style="text-align:center;margin-top:1.25rem">
              No open items. Nice work.
            </p>`}
      </div>
    `;
  }

  // Global site header: centered site name with a hairline beneath it (the
  // header section's border). No avatar, no meta subline (design).
  _siteHeader() {
    const name = (this._site && this._site.name) || "Your site";
    return html`
      <div class="screen__sec sitehead">
        <div class="sitehead__name">${escapeHtml(name)}</div>
      </div>
    `;
  }

  // Section 1: the overall summary of the last submitted check + LAST LOG stamp.
  // Prefer the analyzer's own summary (header `summary`); fall back to a derived
  // one-liner for older checks; render nothing when there is no submitted check.
  _summaryBlock(last) {
    if (!last || !last.submittedAt) return "";
    const log = this._lastLog(last);
    const line = last.summary || log.headline;
    return html`
      <div class="lastlog">
        <p class="lastlog__summary">${escapeHtml(line)}</p>
        ${log.eyebrow
          ? html`<p class="lastlog__eyebrow">${escapeHtml(log.eyebrow)}</p>`
          : ""}
      </div>
    `;
  }

  // The last submitted check as a one-line log:
  //   eyebrow  = "LAST LOG · <relative day> · <time>"
  //   headline = derived fallback used only when the header carries no summary.
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

  // A boxed worklist group (design "D2 boxed groups"). Omitted when empty.
  _group(title, items, className) {
    if (!items.length) return "";
    return html`
      <section class="worklist__group ${className}">
        <h2 class="worklist__label">${escapeHtml(title)}</h2>
        <div class="worklist__cards">
          ${items.map((t) => this._actionCard(t)).join("")}
        </div>
      </section>
    `;
  }

  // A single open task, rendered from its real TASK# fields: when it was flagged,
  // the guidance label, the guidance text, and the task's own action buttons.
  _actionCard(task) {
    const when = task.createdAt
      ? `${relativeDay(task.createdAt)} · ${timeOf(task.createdAt)}`
      : "";
    const title = task.label || task.category || "Finding";
    const detail = task.guidance || task.category || "";
    const actions = this._cardActions(task);
    return html`
      <div class="actioncard" data-task-id="${escapeHtml(task.taskId)}">
        <div class="actioncard__body">
          ${when
            ? html`<span class="actioncard__time">${escapeHtml(when)}</span>`
            : ""}
          <h3 class="actioncard__title">${escapeHtml(title)}</h3>
          ${detail
            ? html`<p class="actioncard__detail">${escapeHtml(detail)}</p>`
            : ""}
        </div>
        ${actions.length
          ? html`<div class="actioncard__actions">
              ${actions.map((a) => this._actionButton(a)).join("")}
            </div>`
          : ""}
        <p class="actioncard__error" role="alert" hidden></p>
      </div>
    `;
  }

  // Resolve a task's catalog button labels (`task.buttons`, a string[]) to the
  // concrete wired actions this screen supports, classifying by label:
  //   "Done"            -> complete       (onsite: staff did it)
  //   "Can't"           -> cannot-do      (only when the task carries reasons)
  //   contains "311"    -> complete, relabeled "Filed 311 ticket" (filed outside)
  //   anything else     -> dropped (e.g. the design's "Check status" — we don't
  //                        model a filed-but-tracked state; a task is open or done)
  // Falls back to sensible defaults by type if a task carries no buttons.
  _cardActions(task) {
    const labels =
      Array.isArray(task.buttons) && task.buttons.length
        ? task.buttons
        : task.type === "city_escalation"
          ? ["File 311 ticket"]
          : ["Done", "Can't"];
    const actions = [];
    for (const label of labels) {
      const l = String(label).toLowerCase();
      if (l.includes("311")) {
        actions.push({
          kind: "file311",
          label: "Filed 311 ticket",
          variant: "blue",
        });
      } else if (l === "done") {
        actions.push({ kind: "done", label: "Done", variant: "ink" });
      } else if (l.includes("can")) {
        if ((task.cannotDoReasons || []).length) {
          actions.push({ kind: "cant", label: "Can't", variant: "outline" });
        }
      }
    }
    return actions;
  }

  _actionButton(a) {
    const cls =
      a.variant === "ink"
        ? "btn-ink btn-ink--sm"
        : a.variant === "blue"
          ? "btn-blue btn-blue--sm"
          : "btn-outline btn-outline--sm";
    return html`<button
      type="button"
      class="${cls}"
      data-action="${a.kind}"
    >
      ${escapeHtml(a.label)}
    </button>`;
  }

  _wireCards() {
    this.querySelectorAll(".actioncard").forEach((card) => {
      const taskId = card.getAttribute("data-task-id");
      const task = this._tasksById.get(taskId);
      if (!task) return;
      this._wireCardButtons(card, task);
    });
  }

  // (Re)attach click handlers to every [data-action] button currently inside a
  // card — used on first render and after swapping in the reason picker.
  _wireCardButtons(card, task) {
    card.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => this._onAction(card, task, btn));
    });
  }

  _onAction(card, task, btn) {
    const action = btn.getAttribute("data-action");
    if (action === "done") {
      this._run(card, () =>
        completeTask(task.taskId, { completionMethod: "manual" }),
      );
    } else if (action === "file311") {
      // No 311 API: filing happens outside the app; this just closes the task.
      this._run(card, () =>
        completeTask(task.taskId, { completionMethod: "311_filed_external" }),
      );
    } else if (action === "cant") {
      this._renderReasonPicker(card, task);
    } else if (action === "cant-reason") {
      const reason = btn.getAttribute("data-reason") || "";
      this._run(card, () => cannotDoTask(task.taskId, { reason }));
    } else if (action === "cant-cancel") {
      this._restoreActions(card, task);
    }
  }

  // "Can't" -> swap the action row for the task's allowlisted reasons (the backend
  // rejects arbitrary ones), plus a cancel.
  _renderReasonPicker(card, task) {
    const actions = card.querySelector(".actioncard__actions");
    if (!actions) return;
    const reasons = task.cannotDoReasons || [];
    actions.innerHTML = html`
      ${reasons
        .map(
          (r) =>
            html`<button
              type="button"
              class="btn-outline btn-outline--sm"
              data-action="cant-reason"
              data-reason="${escapeHtml(r)}"
            >
              ${escapeHtml(r)}
            </button>`,
        )
        .join("")}
      <button
        type="button"
        class="home-cta__link actioncard__cancel"
        data-action="cant-cancel"
      >
        Cancel
      </button>
    `;
    this._wireCardButtons(card, task);
  }

  _restoreActions(card, task) {
    const actions = card.querySelector(".actioncard__actions");
    if (!actions) return;
    actions.innerHTML = this._cardActions(task)
      .map((a) => this._actionButton(a))
      .join("");
    this._wireCardButtons(card, task);
  }

  // Run a task mutation: disable the card's buttons, and on success re-render the
  // whole view so the worklist and the "To do" count stay consistent; on failure
  // re-enable and show an inline, non-destructive error on the card.
  async _run(card, fn) {
    const buttons = card.querySelectorAll("button");
    const err = card.querySelector(".actioncard__error");
    buttons.forEach((b) => (b.disabled = true));
    if (err) {
      err.hidden = true;
      err.textContent = "";
    }
    try {
      await fn();
      this.connectedCallback();
    } catch (e) {
      console.error("task action failed", e);
      buttons.forEach((b) => (b.disabled = false));
      if (err) {
        err.hidden = false;
        err.textContent = "Couldn’t save that — please try again.";
      }
    }
  }

  // Backend unreachable on load. Online-only: surface it with a retry rather than
  // silently degrading (offline is post-MVP; no local read fallback).
  _renderError() {
    this.innerHTML = html`
      <div class="home">
        <div class="screen" role="group" aria-label="Today">
          ${this._siteHeader()}
          <div class="screen__sec home-lead">
            <div class="lastlog">
              <p class="lastlog__eyebrow">CAN’T REACH THE SERVER</p>
              <p class="lastlog__summary">Checks are unavailable</p>
            </div>
            <div class="home-cta">
              <button id="retry" class="btn-ink btn-ink--block" type="button">
                Try again
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
    this.querySelector("#retry")?.addEventListener("click", () =>
      this.connectedCallback(),
    );
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
